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
    getPdfParts,
    normalizeDataPart,
    type DataPartLike,
} from './replay.js';
import type {
    VisionDescriber,
    VisionProxySource,
    VisionResolutionResult,
    VisionResolutionStats,
} from './types.js';
import { VSCodeLanguageModelVisionDescriber, findVisionModelByKey, getVisionPrompt } from './sources/vscode-lm.js';
import { ApiEndpointVisionDescriber, type ApiEndpointConfig } from './sources/api-endpoint.js';
import { getPdfVisionFallback, getPdfVisionFallbackMinChars, getPdfMaxPages } from '../config.js';
import { extractPdfTextWithPdfjs, isPdfMime } from '../pdf/extract.js';

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
// Keyed by (sessionKey + truncated hash of the first image's raw bytes).
// The agent shifts message indices between loop iterations but the image
// bytes stay the same, so content-hash keys work across calls. sessionKey is
// derived from the earliest user turns' text, scoping the cache to its own
// conversation so one chat's descriptions (or failed-image sentinels) never
// leak into another that happens to contain the same attachment bytes.
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
    // cache. The cache is keyed by (sessionKey, image byte hash), so it's
    // scoped per conversation and collision-safe. Keeping it across turns
    // prevents re-describing the same image when the user continues the
    // conversation with the same attachment — fixing the "vision only works
    // on 2nd attempt" bug.
    cachedMessageCount = messages.length;
}

/**
 * Derive a stable per-conversation identity from the message history CONTENT.
 *
 * VS Code does not pass a session/conversation id to
 * `provideLanguageModelChatResponse` — the provider is genuinely stateless
 * (Copilot re-sends the full history every turn, and Nika's replay markers
 * are the only in-band session state). So we reconstruct a conversation key
 * from the text of the earliest user turns: within one chat that text is
 * stable across turns (and across agent-loop iterations, which only shift
 * part indices), while across different chats it differs. Scoping the image
 * cache by this key keeps one conversation's descriptions — and its
 * failed-image sentinels — from leaking into another that happens to contain
 * the same attachment bytes.
 */
function sessionKeyFromMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
    let h = 0x811c9dc5;
    let userTurns = 0;
    for (const msg of messages) {
        if (msg.role !== vscode.LanguageModelChatMessageRole.User) continue;
        let text = '';
        if (typeof msg.content === 'string') {
            text = msg.content;
        } else if (Array.isArray(msg.content)) {
            text = msg.content
                .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
                .map(p => p.value)
                .join(' ');
        }
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            h ^= c;
            h = Math.imul(h, 0x01000193);
        }
        userTurns++;
        if (userTurns >= 3) break;
    }
    return (h >>> 0).toString(36);
}

function getCachedVisionByImage(sessionKey: string, imageParts: DataPartLike[]): string | undefined {
    if (imageParts.length === 0) return undefined;
    const key = `${sessionKey}:${hashImageBytes(imageParts[0].data)}`;
    const cached = sessionImageCache.get(key);
    // '' (empty string) = failed sentinel — return as-is so the caller
    // can distinguish "cached as failed" from "not in cache" (undefined).
    return cached;
}

/** Returns true if the image was previously cached as failed. */
function isFailedImage(sessionKey: string, imageParts: DataPartLike[]): boolean {
    if (imageParts.length === 0) return false;
    const key = `${sessionKey}:${hashImageBytes(imageParts[0].data)}`;
    return sessionImageCache.get(key) === '';
}

function setCachedVisionByImage(sessionKey: string, imageParts: DataPartLike[], text: string): void {
    if (imageParts.length === 0) return;
    const key = `${sessionKey}:${hashImageBytes(imageParts[0].data)}`;
    sessionImageCache.set(key, text);
}

/** Mark an image as failed so it's silently skipped on subsequent turns. */
function markFailedImage(sessionKey: string, imageParts: DataPartLike[]): void {
    if (imageParts.length === 0) return;
    const key = `${sessionKey}:${hashImageBytes(imageParts[0].data)}`;
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

    // Session identity for the image cache. Derived from the earliest user
    // turns' content (VS Code passes no session id to the provider) so each
    // conversation is cached independently.
    const sessionKey = sessionKeyFromMessages(messages);

    // No images at all — pass through unchanged
    if (stats.inputImageParts === 0) {
        return {
            messages,
            stats,
            replayMarkerMetadata: {},
            sessionKey,
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
            const cachedText = getCachedVisionByImage(sessionKey, imageParts);
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
                setCachedVisionByImage(sessionKey, imageParts, visionText);
            } else {
                markFailedImage(sessionKey, imageParts);
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
        const cachedText = getCachedVisionByImage(sessionKey, imageParts);
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
        sessionKey,
    };
}

// ---------------------------------------------------------------------------
// Sparse-PDF vision enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich sparse / image-based PDFs with a vision-model description.
 *
 * Local text extraction is the primary path — it's fast, free, and works for
 * text PDFs (contracts, papers). But floor plans, drawings, and scanned PDFs
 * yield little or no text (a 2MB floor plan can extract < 1.5K chars), so the
 * model misses the actual visual content.
 *
 * When a PDF's extracted text is below `nikas.pdfVisionFallbackMinChars`, and
 * a DIRECT-API describer (Gemini — reads `application/pdf` natively) is
 * available, we describe the PDF via vision and REPLACE the data part with a
 * text part carrying both the extracted text and the vision description.
 *
 * Only direct-API describers qualify: Copilot LM (vscode-lm) models do NOT
 * accept PDF documents, so with those the PDF stays as-is and reaches the
 * local text-extraction fallback unchanged.
 *
 * Falls back gracefully — if no qualifying describer, vision fails, or the
 * PDF already has rich text, the messages are returned unchanged.
 */
export async function resolveSparsePdfVision(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    token: vscode.CancellationToken,
    getDescriber: () => Promise<VisionDescriber | undefined>,
): Promise<readonly vscode.LanguageModelChatRequestMessage[]> {
    if (!getPdfVisionFallback()) {
        return messages;
    }

    // Find the current (latest) user message that contains PDFs.
    const currentPdfIndex = findCurrentPdfMessageIndex(messages);
    if (currentPdfIndex === undefined) {
        return messages;
    }
    const message = messages[currentPdfIndex];
    const pdfParts = getPdfParts(message);
    if (pdfParts.length === 0) {
        return messages;
    }

    // Determine which PDFs are sparse (little extracted text). Only consider
    // small PDFs — a huge multi-page PDF (book, manual) would exceed the
    // vision model's per-request limits, so it stays on local text extraction
    // (which is page-capped separately in the transform).
    const minChars = getPdfVisionFallbackMinChars();
    const maxSparsePdfPages = getPdfMaxPages() > 0 ? getPdfMaxPages() : 200;
    const sparse: { partIndex: number; pdf: DataPartLike; text: string }[] = [];
    const content = message.content as readonly vscode.LanguageModelInputPart[];
    for (const [partIndex, part] of content.entries()) {
        const norm = normalizeDataPart(part);
        if (!norm || !isPdfMime(norm.mimeType)) continue;
        const extracted = await extractPdfTextWithPdfjs(norm.data, { maxPages: maxSparsePdfPages + 1 });
        if (extracted.totalPages > maxSparsePdfPages) {
            visionLog.info(
                `Sparse-PDF vision skipped: PDF has ${extracted.totalPages} pages (> ${maxSparsePdfPages}) — page-capped text extraction only`
            );
            continue;
        }
        if (extracted.text.length < minChars) {
            sparse.push({ partIndex, pdf: norm, text: extracted.text });
        }
    }
    if (sparse.length === 0) {
        return messages; // all PDFs already have rich text
    }

    // Only direct-API (Gemini) describers can read PDF documents natively.
    const describer = await getDescriber();
    if (!describer || describer.source === 'vscode-lm') {
        visionLog.info(
            `Sparse PDF(s) present (${sparse.length}) but no direct-API (Gemini) describer — keeping local text extraction`
        );
        return messages;
    }

    // Describe the sparse PDFs via the vision model.
    const newContent = [...content];
    let describedCount = 0;
    for (const { partIndex, pdf, text } of sparse) {
        if (token.isCancellationRequested) break;
        try {
            const description = await describer.describe({
                prompt: getVisionPrompt(),
                images: [{ mimeType: pdf.mimeType, data: pdf.data }],
                token,
            });
            if (description.length === 0) {
                visionLog.info(`Sparse PDF vision returned empty — keeping local text`);
                continue;
            }
            const enriched = text
                ? `[Attached PDF contents (text + vision):\n${text}\n\n---\nVisual description:\n${description}\n]`
                : `[Attached PDF (vision description):\n${description}\n]`;
            newContent[partIndex] = new vscode.LanguageModelTextPart(enriched);
            describedCount += 1;
        } catch (err) {
            visionLog.error('Sparse PDF vision describe failed', err);
        }
    }

    if (describedCount === 0) {
        return messages; // all describes failed — keep local extraction
    }

    const result = [...messages] as vscode.LanguageModelChatRequestMessage[];
    result[currentPdfIndex] = {
        role: message.role,
        content: newContent,
        name: message.name,
    } as unknown as vscode.LanguageModelChatRequestMessage;

    visionLog.info(
        `Sparse PDF vision enrichment: described ${describedCount}/${sparse.length} sparse PDF(s) via ${describer.id}`
    );
    return result;
}

/**
 * Find the LAST user message in the conversation that contains PDF parts.
 * Mirrors findCurrentImageMessageIndex — the newest PDF-bearing user message
 * is found regardless of trailing assistant/tool messages (see the image
 * variant for why bailing on a trailing assistant wrongly skipped the current
 * turn's attachment).
 */
function findCurrentPdfMessageIndex(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
): number | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== vscode.LanguageModelChatMessageRole.User) {
            continue;
        }
        if (getPdfParts(message).length > 0) {
            return index;
        }
    }
    return undefined;
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

/**
 * Structural "ordinary conversation part, not an attachment" check.
 *
 * Matches the shape of LanguageModelTextPart ({value}), LanguageModelToolCallPart
 * ({callId,name,input}) and LanguageModelToolResultPart ({callId,output,isError})
 * WITHOUT `instanceof` — patched-bundle parts cross an extension-host realm
 * where instanceof is unreliable (see replay.ts normalizeDataPart). These parts
 * appear in EVERY request, so logging them as "unknown shapes" (as seen in the
 * `rn{value}` noise) would drown out genuinely novel attachment forms.
 */
function isNonBinaryPart(part: unknown): boolean {
    if (typeof part !== 'object' || part === null) return true; // primitives aren't attachments
    const obj = part as Record<string, unknown>;
    if (typeof obj.value === 'string') return true;  // LanguageModelTextPart
    if (typeof obj.callId === 'string') return true; // tool call / tool result part
    return false;
}

/** Log a one-line summary of all data parts (image/PDF/unknown) in the request. */
function logDataPartSummary(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
): void {
    const byMime = new Map<string, number>();
    const unknownShapes: string[] = [];
    let total = 0;
    for (const message of messages) {
        const content = message.content as readonly vscode.LanguageModelInputPart[] | undefined;
        if (!content) continue;
        for (const part of content) {
            const norm = normalizeDataPart(part);
            if (norm) {
                byMime.set(norm.mimeType, (byMime.get(norm.mimeType) ?? 0) + 1);
                total += 1;
            } else if (isNonBinaryPart(part)) {
                // Text / tool parts are normal conversation content, not
                // attachments — skip so only novel shapes are surfaced.
                continue;
            } else if (typeof part === 'object' && part !== null) {
                // Not a recognized binary part — log its shape once so new
                // attachment forms are visible instead of silently dropped.
                const keys = Object.keys(part as object).sort().join(',');
                const ctor = (part as object).constructor?.name ?? '?';
                const sig = `${ctor}{${keys}}`;
                if (!unknownShapes.includes(sig)) unknownShapes.push(sig);
            }
        }
    }
    if (total > 0) {
        const summary = [...byMime.entries()].map(([m, n]) => `${m} x${n}`).join(', ');
        visionLog.info(`Request data parts (${total}): ${summary}`);
    }
    if (unknownShapes.length > 0) {
        visionLog.info(`Request part shapes not recognized as data: ${unknownShapes.join(' | ')}`);
    }
}

/**
 * Find the LAST user message in the conversation that contains images.
 *
 * We deliberately do NOT bail when a trailing assistant/tool message follows
 * the image message: in agent mode the current user turn (with freshly
 * attached images) is immediately followed by assistant tool-call messages,
 * and treating that as "already answered" made the newest images silently
 * dropped without ever being described (observed: `current=0 ... omitted=1`
 * with `image/png` parts present in the request). Already-described image
 * turns are handled earlier by marker replay (Case A) / cache (Case C), so
 * returning the last image-bearing user message here is safe — the one thing
 * it changes is that an UNRESOLVED image message finally gets described once
 * and cached instead of being discarded.
 */
function findCurrentImageMessageIndex(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
): number | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
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

function toVisionImagePart(part: DataPartLike): import('./types.js').VisionImagePart {
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
