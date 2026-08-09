import * as vscode from 'vscode';
import { visionLog } from './log.js';
import {
    IMAGE_DESCRIPTION_PROMPT,
    IMAGE_DESCRIPTION_UNAVAILABLE,
} from './consts.js';
import {
    createVisionMarkerBindings,
    createVisionReplayText,
    createImageDescriptionText,
    getImageParts,
    getNonImageParts,
} from './replay.js';
import type {
    VisionDescriber,
    VisionProxySource,
    VisionResolutionResult,
    VisionResolutionStats,
} from './types.js';
import { VSCodeLanguageModelVisionDescriber, findVisionModelByKey, getVisionPrompt } from './sources/vscode-lm.js';
import { ApiEndpointVisionDescriber, type ApiEndpointConfig } from './sources/api-endpoint.js';

/**
 * Vision preprocessing pipeline using replay markers.
 *
 * Core design (matching Vizards):
 * 1. Historical images → replay marker text (no API call, survives reload)
 * 2. Only the LAST user message with images → describe via chosen vision model
 * 3. Older images without markers → silently dropped (no longer relevant)
 * 4. Descriptions embedded in assistant responses as replay markers
 *
 * Agent loop persistence:
 * The Copilot agent reconstructs messages between loop iterations (stripping
 * LanguageModelDataPart and shifting indices). To keep vision descriptions
 * across iterations, we use a session-level cache keyed by the raw image
 * bytes hash. This survives index shifts because the image data is stable.
 */

// ── Agent-loop cache ──────────────────────────────────────────────────────
// Keyed by truncated hash of the first image's raw bytes.
// The agent shifts message indices between loop iterations but the image
// bytes stay the same, so content-hash keys work across calls.
//
// Values:
//   string (non-empty) — successful description, reuse it
//   '' (empty string)  — sentinel: description failed, skip silently
//   undefined (not in map) — never seen before, attempt to describe
let sessionImageCache = new Map<string, string>();
let cachedMessageCount = 0;

function hashImageBytes(data: Uint8Array): string {
    // Simple FNV-1a hash of first 4096 bytes (fast, collision-resistant enough)
    let hash = 0x811c9dc5;
    const len = Math.min(data.length, 4096);
    for (let i = 0; i < len; i++) {
        hash ^= data[i];
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36); // unsigned 32-bit as base-36 string
}

function clearSessionCacheIfNewTurn(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
    // Track message count to detect direction changes, but do NOT clear the
    // cache. The cache is keyed by image byte hash (FNV-1a), so it's
    // collision-safe. Keeping it across turns prevents re-describing the
    // same image when the user continues the conversation with the same
    // attachment — fixing the "vision only works on 2nd attempt" bug.
    cachedMessageCount = messages.length;
}

function getCachedVisionByImage(imageParts: vscode.LanguageModelDataPart[]): string | undefined {
    if (imageParts.length === 0) return undefined;
    const key = hashImageBytes(imageParts[0].data);
    const cached = sessionImageCache.get(key);
    // '' (empty string) = failed sentinel — return as-is so the caller
    // can distinguish "cached as failed" from "not in cache" (undefined).
    return cached;
}

/** Returns true if the image was previously cached as failed. */
function isFailedImage(imageParts: vscode.LanguageModelDataPart[]): boolean {
    if (imageParts.length === 0) return false;
    const key = hashImageBytes(imageParts[0].data);
    return sessionImageCache.get(key) === '';
}

function setCachedVisionByImage(imageParts: vscode.LanguageModelDataPart[], text: string): void {
    if (imageParts.length === 0) return;
    const key = hashImageBytes(imageParts[0].data);
    sessionImageCache.set(key, text);
}

/** Mark an image as failed so it's silently skipped on subsequent turns. */
function markFailedImage(imageParts: vscode.LanguageModelDataPart[]): void {
    if (imageParts.length === 0) return;
    const key = hashImageBytes(imageParts[0].data);
    sessionImageCache.set(key, ''); // empty string = failed sentinel
}

/**
 * Resolve image parts in VS Code messages to text descriptions.
 *
 * Operates on VS Code messages (pre-conversion to DeepSeek format) so we can
 * manipulate LanguageModelDataPart / LanguageModelTextPart directly.
 *
 * @param messages The full VS Code chat message array
 * @param token Cancellation token
 * @param getDescriber Factory for the vision describer (lazy — only called if needed)
 * @returns Resolved messages + stats + replay marker metadata
 */
export async function resolveImageMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    token: vscode.CancellationToken,
    getDescriber: () => Promise<VisionDescriber | undefined>,
): Promise<VisionResolutionResult> {
    const stats = createVisionResolutionStats();
    collectInputImageStats(messages, stats);

    // Diagnosability: summarize every data part (images, PDFs, unknown) seen
    // across the request so attachment losses are visible in the log.
    logDataPartSummary(messages);

    // Clear the agent-loop cache on new user turns
    clearSessionCacheIfNewTurn(messages);

    // No images at all — pass through unchanged
    if (stats.inputImageParts === 0) {
        return {
            messages,
            stats,
            replayMarkerMetadata: {},
        };
    }

    // Phase 1: Build replay marker bindings from previous assistant responses
    const markerBindings = createVisionMarkerBindings(messages, stats);

    // Phase 2: Find the current (latest) user message with images
    const currentImageMessageIndex = findCurrentImageMessageIndex(messages);

    // Phase 3: Resolve each message
    const result: vscode.LanguageModelChatRequestMessage[] = [];
    let visionDescriber: VisionDescriber | undefined;
    let visionDescriberRequested = false;
    let missingVisionProxy = false;
    let visionFailureNotice: string | undefined;
    let markerVisionText: string | undefined;

    for (const [messageIndex, message] of messages.entries()) {
        if (token.isCancellationRequested) break;

        const imageParts = getImageParts(message);
        if (imageParts.length === 0) {
            // No images — pass through unchanged (PDFs stay as non-image parts
            // and reach the local text-extraction fallback)
            result.push(message as vscode.LanguageModelChatRequestMessage);
            continue;
        }

        const nonImageParts = getNonImageParts(message);

        // Case A: Replay marker found — use cached description, no API call
        const replayText = markerBindings.get(messageIndex);
        if (replayText) {
            stats.replayedImageMessages += 1;
            stats.droppedImageParts += imageParts.length;
            result.push(
                createResolvedMessage(message, [
                    ...nonImageParts,
                    new vscode.LanguageModelTextPart(replayText),
                ]),
            );
            continue;
        }

        // Case B: This is the current (latest) user message with images/PDFs — describe it
        if (messageIndex === currentImageMessageIndex) {
            stats.currentImageMessages += 1;

            // Check agent-loop cache first — same image might have been
            // described in a previous turn (e.g. the user re-asks with the
            // same attachment). Skip the API call if we have it cached.
            const cachedText = getCachedVisionByImage(imageParts);
            if (cachedText !== undefined) {
                // Empty string = previously failed — drop images silently.
                // (PDFs are NOT vision parts; they survive in nonImageParts
                // and reach the local text-extraction fallback.)
                if (cachedText === '') {
                    visionLog.info(`Skipping failed image in message [${messageIndex}] (cached as failed)`);
                    stats.omittedImageMessages += 1;
                    stats.droppedImageParts += imageParts.length;
                    result.push(createResolvedMessage(message, nonImageParts));
                    continue;
                }
                visionLog.info(`Reused session-cached vision for current message [${messageIndex}]`);
                stats.replayedImageMessages += 1;
                markerVisionText = cachedText;
                stats.markerVisionTextChars = cachedText.length;
                result.push(
                    createResolvedMessage(message, [
                        ...nonImageParts,
                        new vscode.LanguageModelTextPart(cachedText),
                    ]),
                );
                continue;
            }

            if (!visionDescriberRequested) {
                visionDescriberRequested = true;
                visionDescriber = await getDescriber();
            }

            const visionResolution = await resolveCurrentVisionText(
                imageParts,
                nonImageParts,
                visionDescriber,
                stats,
                token,
            );

            const visionText = visionResolution.text;
            if (!visionDescriber && !token.isCancellationRequested) {
                missingVisionProxy = true;
            }
            visionFailureNotice ??= visionResolution.failureNotice;
            markerVisionText = visionText;
            stats.markerVisionTextChars = visionText.length;

            // Cache the description for agent loop persistence (by attachment hash).
            // Only cache successful descriptions — if the describer failed or was
            // unavailable we don't want to replay "[Image Description unavailable]"
            // on every subsequent turn. Instead, mark as failed so we skip silently.
            if (!visionResolution.failureNotice && !missingVisionProxy) {
                setCachedVisionByImage(imageParts, visionText);
            } else {
                markFailedImage(imageParts);
            }

            result.push(
                createResolvedMessage(message, [
                    ...nonImageParts,
                    new vscode.LanguageModelTextPart(visionText),
                ]),
            );
            continue;
        }

        // Case C: Old image message with no marker — check session cache
        // first, then fall back to dropping images. Non-image parts (text,
        // PDFs) always survive — PDFs reach the local text-extraction
        // fallback in vscodeMessagesToDeepSeek.
        const cachedText = getCachedVisionByImage(imageParts);
        if (cachedText !== undefined) {
            // Empty string = previously failed — drop images silently.
            if (cachedText === '') {
                visionLog.info(`Skipping failed image in message [${messageIndex}] (cached as failed)`);
                stats.omittedImageMessages += 1;
                stats.droppedImageParts += imageParts.length;
                result.push(createResolvedMessage(message, nonImageParts));
                continue;
            }
            stats.replayedImageMessages += 1;
            stats.droppedImageParts += imageParts.length;
            visionLog.info(`Reused session-cached vision for message [${messageIndex}] (${imageParts.length} image(s))`);
            result.push(
                createResolvedMessage(message, [
                    ...nonImageParts,
                    new vscode.LanguageModelTextPart(cachedText),
                ]),
            );
            continue;
        }

        visionLog.info(`No cache hit for message [${messageIndex}] — omitting ${imageParts.length} image(s)`);

        // Case D: Truly old image with no marker and no cache — drop images,
        // keep everything else (text, PDFs).
        stats.omittedImageMessages += 1;
        stats.droppedImageParts += imageParts.length;
        result.push(createResolvedMessage(message, nonImageParts));
    }

    return {
        messages: result,
        stats,
        replayMarkerMetadata: { visionText: markerVisionText },
        visionModelId: visionDescriber?.id,
        visionProxySource: visionDescriber?.source,
        initialResponseNotice: missingVisionProxy
            ? createVisionProxyMissingNotice()
            : visionFailureNotice,
    };
}

// ---------------------------------------------------------------------------
// Describer resolution
// ---------------------------------------------------------------------------

/**
 * Create a vision describer based on the current configuration.
 * Supports two sources:
 *   - 'vscode-lm': Uses a Copilot vision model (Gemini/Gemma4 registered as providers, or existing models)
 *   - 'api-endpoint': Direct API endpoint (OpenAI/Anthropic compatible)
 */
export async function resolveVisionDescriber(
    config: {
        source: VisionProxySource;
        visionModelKey?: string;
        apiEndpointConfig?: ApiEndpointConfig;
    },
): Promise<VisionDescriber | undefined> {
    if (config.source === 'vscode-lm' && config.visionModelKey) {
        const model = await findVisionModelByKey(config.visionModelKey);
        if (model) {
            return new VSCodeLanguageModelVisionDescriber(model);
        }
        visionLog.warn(`Vision model not found: ${config.visionModelKey}`);
        return undefined;
    }

    if (config.source === 'api-endpoint' && config.apiEndpointConfig) {
        return new ApiEndpointVisionDescriber(
            `api:${config.apiEndpointConfig.modelId}`,
            config.apiEndpointConfig,
        );
    }

    return undefined;
}

// ---------------------------------------------------------------------------
// Current image resolution
// ---------------------------------------------------------------------------

interface CurrentVisionResolution {
    text: string;
    failureNotice?: string;
}

async function resolveCurrentVisionText(
    imageParts: vscode.LanguageModelDataPart[],
    nonImageParts: readonly vscode.LanguageModelInputPart[],
    visionDescriber: VisionDescriber | undefined,
    stats: VisionResolutionStats,
    token: vscode.CancellationToken,
): Promise<CurrentVisionResolution> {
    // No describer available — mark as unavailable
    if (!visionDescriber || token.isCancellationRequested) {
        if (!visionDescriber) {
            visionLog.warn('No vision describer available');
        }
        stats.unavailableImageMessages += 1;
        return {
            text: createVisionReplayText(IMAGE_DESCRIPTION_UNAVAILABLE, nonImageParts),
        };
    }

    // Describe the image(s) via the chosen vision model
    try {
        const description = await visionDescriber.describe({
            prompt: getVisionPrompt(),
            images: imageParts.map(toVisionImagePart),
            token,
        });

        if (description.length === 0) {
            stats.failedImageMessages += 1;
            return createFailedVisionResolution(
                'empty-response',
                'Vision model returned empty response',
                nonImageParts,
            );
        }

        stats.generatedImageMessages += 1;
        return {
            text: createVisionReplayText(
                createImageDescriptionText(description),
                nonImageParts,
            ),
        };
    } catch (error) {
        visionLog.error('Vision describe failed', error);
        stats.failedImageMessages += 1;
        return createFailedVisionResolution(
            'describe-error',
            error instanceof Error ? error.message : String(error),
            nonImageParts,
        );
    }
}

function createFailedVisionResolution(
    errorCode: string,
    errorMessage: string,
    nonImageParts: readonly vscode.LanguageModelInputPart[],
): CurrentVisionResolution {
    return {
        text: createVisionReplayText(IMAGE_DESCRIPTION_UNAVAILABLE, nonImageParts),
        failureNotice: createVisionProxyFailureNotice(errorCode, errorMessage),
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createVisionResolutionStats(): VisionResolutionStats {
    return {
        inputImageParts: 0,
        inputImageMessages: 0,
        currentImageMessages: 0,
        generatedImageMessages: 0,
        replayedImageMessages: 0,
        omittedImageMessages: 0,
        unavailableImageMessages: 0,
        failedImageMessages: 0,
        droppedImageParts: 0,
        markerVisionTextChars: 0,
        invalidMarkerVisionMetadata: 0,
    };
}

function collectInputImageStats(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    stats: VisionResolutionStats,
): void {
    for (const message of messages) {
        const imageParts = getImageParts(message).length;
        if (imageParts === 0) continue;
        stats.inputImageMessages += 1;
        stats.inputImageParts += imageParts;
    }
}

/** Log a one-line summary of all data parts (image/PDF/unknown) in the request. */
function logDataPartSummary(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
): void {
    const byMime = new Map<string, number>();
    let total = 0;
    for (const message of messages) {
        const content = message.content as readonly vscode.LanguageModelInputPart[] | undefined;
        if (!content) continue;
        for (const part of content) {
            const p = part as { data?: unknown; mimeType?: unknown } | null;
            if (!p || typeof p !== 'object' || p === null) continue;
            if (!(p.data instanceof Uint8Array) || typeof p.mimeType !== 'string') continue;
            byMime.set(p.mimeType, (byMime.get(p.mimeType) ?? 0) + 1);
            total += 1;
        }
    }
    if (total > 0) {
        const summary = [...byMime.entries()].map(([m, n]) => `${m} x${n}`).join(', ');
        visionLog.info(`Request data parts (${total}): ${summary}`);
    }
}

/**
 * Find the LAST user message in the conversation that contains images.
 * If the most recent non-user message is an assistant message, there's no
 * "current" image to describe — the last image turn has already been answered.
 */
function findCurrentImageMessageIndex(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
): number | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        // If we hit an assistant message first, there's no current user image
        if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
            return undefined;
        }
        if (message.role !== vscode.LanguageModelChatMessageRole.User) {
            continue;
        }
        if (getImageParts(message).length > 0) {
            return index;
        }
    }
    return undefined;
}

function createResolvedMessage(
    message: vscode.LanguageModelChatRequestMessage,
    content: readonly vscode.LanguageModelInputPart[],
): vscode.LanguageModelChatRequestMessage {
    return {
        role: message.role,
        content,
        name: message.name,
    } as unknown as vscode.LanguageModelChatRequestMessage;
}

function toVisionImagePart(part: vscode.LanguageModelDataPart): import('./types.js').VisionImagePart {
    return {
        mimeType: part.mimeType,
        data: part.data,
    };
}

function createVisionProxyMissingNotice(): string {
    return '⚠️ No vision model is configured. Images will not be described. '
        + 'Run "Nikas: Manage → Choose Vision Model" to select one.';
}

function createVisionProxyFailureNotice(errorCode: string, errorMessage: string): string {
    return `⚠️ Vision model error (${errorCode}): ${errorMessage}`;
}
