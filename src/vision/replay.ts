import * as vscode from 'vscode';
import {
    REPLAY_MARKER_MIME,
    REPLAY_MARKER_WRITER_ID,
    IMAGE_DESCRIPTION_PREFIX,
    IMAGE_DESCRIPTION_SUFFIX,
    IMAGE_DESCRIPTION_UNAVAILABLE,
} from './consts.js';
import { isPdfMime } from '../pdf/extract.js';
import type { ReplayMarkerMetadata, VisionResolutionStats } from './types.js';
import { visionLog } from './log.js';

export { REPLAY_MARKER_MIME };

// ---------------------------------------------------------------------------
// Replay Marker Format
// ---------------------------------------------------------------------------
// Markers are stored as LanguageModelDataPart with MIME type 'stateful_marker'.
// The data is: <writerId>\<base64url-json-payload>
//
// Payload schema:
//   { vision?: { text: string }, reasoning?: { text: string }, segmentId?: string }
//
// Example:
//   nikas\{ "vision": { "text": "[Image Description: A screenshot of ...]" } }
// ---------------------------------------------------------------------------

export interface ReplayMarkerParseResult {
    valid: boolean;
    segmentId?: string;
    visionText?: string;
    visionTextIgnoredReason?: VisionMarkerTextIgnoredReason;
    reasoningText?: string;
    reasoningTextIgnoredReason?: ReasoningMarkerTextIgnoredReason;
    error?: string;
}

export type VisionMarkerTextIgnoredReason =
    | 'vision-not-object'
    | 'vision-text-not-string'
    | 'vision-text-empty';

export type ReasoningMarkerTextIgnoredReason =
    | 'reasoning-not-object'
    | 'reasoning-text-not-string'
    | 'reasoning-text-empty';

// ---------------------------------------------------------------------------
// Creating replay markers
// ---------------------------------------------------------------------------

/**
 * Create a replay marker data part from vision metadata.
 * This is appended to the assistant response so the next turn can replay
 * the description without calling the vision model again.
 */
export function createReplayMarkerPart(
    metadata: ReplayMarkerMetadata,
): vscode.LanguageModelDataPart {
    const payloadObj: Record<string, unknown> = {};

    if (metadata.visionText) {
        payloadObj.vision = { text: metadata.visionText };
    }
    if (metadata.reasoningText) {
        payloadObj.reasoning = { text: metadata.reasoningText };
    }

    const payload = encodeReplayMarkerJson(payloadObj);
    const marker = `${REPLAY_MARKER_WRITER_ID}\\${payload}`;

    return new vscode.LanguageModelDataPart(
        new TextEncoder().encode(marker),
        REPLAY_MARKER_MIME,
    );
}

// ---------------------------------------------------------------------------
// Parsing replay markers
// ---------------------------------------------------------------------------

/**
 * Parse replay marker data from a LanguageModelDataPart.
 */
export function parseReplayMarkerData(data: Uint8Array): ReplayMarkerParseResult {
    const raw = new TextDecoder().decode(data);

    // Must start with known prefix
    if (!raw.includes('\\')) {
        return { valid: false, error: 'no-separator' };
    }

    const sepIndex = raw.indexOf('\\');
    const prefix = raw.slice(0, sepIndex);
    const payloadRaw = raw.slice(sepIndex + 1);

    // Accept the Nikas writer prefix (or any model ID for compatibility)
    if (prefix !== REPLAY_MARKER_WRITER_ID) {
        return { valid: false, error: `unknown-writer: ${prefix}` };
    }

    return decodeReplayMarkerPayload(payloadRaw);
}

/**
 * Find the first replay marker in an assistant message.
 */
export function findFirstReplayMarker(
    message: vscode.LanguageModelChatRequestMessage,
): { partIndex: number; marker: ReplayMarkerParseResult } | undefined {
    for (const [partIndex, part] of message.content.entries()) {
        if (!(part instanceof vscode.LanguageModelDataPart)) {
            continue;
        }
        if (part.mimeType !== REPLAY_MARKER_MIME) {
            continue;
        }
        const marker = parseReplayMarkerData(part.data);
        return { partIndex, marker };
    }
    return undefined;
}

/**
 * Shorthand — parse the first replay marker from a message, if any.
 */
export function parseFirstReplayMarker(
    message: vscode.LanguageModelChatRequestMessage,
): ReplayMarkerParseResult | undefined {
    return findFirstReplayMarker(message)?.marker;
}

// ---------------------------------------------------------------------------
// Vision marker binding (replay mapping)
// ---------------------------------------------------------------------------

/**
 * Extract vision text from an assistant message's replay marker.
 * Returns undefined if no valid vision text is found.
 */
export function findAssistantVisionText(
    message: vscode.LanguageModelChatRequestMessage,
    stats: VisionResolutionStats,
): string | undefined {
    const marker = parseFirstReplayMarker(message);
    if (!marker) {
        return undefined;
    }
    if (!marker.valid) {
        stats.invalidMarkerVisionMetadata += 1;
        return undefined;
    }
    if (marker.visionText) {
        return marker.visionText;
    }
    if (marker.visionTextIgnoredReason) {
        stats.invalidMarkerVisionMetadata += 1;
    }
    return undefined;
}

/**
 * Scan assistant messages for replay markers and build a map from
 * user message index → vision text.
 *
 * For each assistant message that carries a vision marker, we find the
 * nearest preceding user message that contains image parts and bind
 * the vision text to it. This way the next turn can replay the description
 * without re-calling the vision model.
 */
export function createVisionMarkerBindings(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    stats: VisionResolutionStats,
): Map<number, string> {
    const bindings = new Map<number, string>();
    const boundUserMessages = new Set<number>();

    for (const [messageIndex, message] of messages.entries()) {
        if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
            continue;
        }

        const visionText = findAssistantVisionText(message, stats);
        if (!visionText) {
            continue;
        }

        // Walk backwards to find the nearest unbound user message with images
        for (let userIndex = messageIndex - 1; userIndex >= 0; userIndex -= 1) {
            if (boundUserMessages.has(userIndex)) {
                continue;
            }
            const candidate = messages[userIndex];
            if (candidate.role !== vscode.LanguageModelChatMessageRole.User) {
                continue;
            }
            if (getImageParts(candidate).length === 0) {
                continue;
            }

            bindings.set(userIndex, visionText);
            boundUserMessages.add(userIndex);
            break;
        }
    }

    return bindings;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Check if a message contains image data parts.
 */
export function hasImageParts(
    message: vscode.LanguageModelChatRequestMessage,
): boolean {
    return getImageParts(message).length > 0;
}

/**
 * Extract image data parts from a message (any shape, normalized).
 */
export function getImageParts(
    message: vscode.LanguageModelChatRequestMessage,
): DataPartLike[] {
    return (message.content as readonly vscode.LanguageModelInputPart[])
        .map(normalizeDataPart)
        .filter((p): p is DataPartLike => p !== undefined && p.mimeType.toLowerCase().startsWith('image/'));
}

/**
 * Extract PDF data parts (application/pdf) from a message.
 *
 * PDFs are vision-eligible when the describer can read documents (Gemini
 * direct API), otherwise they fall back to the local text-extraction in
 * vscodeMessagesToDeepSeek.
 */
export function getPdfParts(
    message: vscode.LanguageModelChatRequestMessage,
): DataPartLike[] {
    return (message.content as readonly vscode.LanguageModelInputPart[])
        .map(normalizeDataPart)
        .filter((p): p is DataPartLike => p !== undefined && isPdfMime(p.mimeType));
}

/**
 * Extract ALL vision-eligible data parts (images + PDFs) from a message.
 */
export function getVisionParts(
    message: vscode.LanguageModelChatRequestMessage,
): DataPartLike[] {
    return (message.content as readonly vscode.LanguageModelInputPart[])
        .map(normalizeDataPart)
        .filter((p): p is DataPartLike => isImageDataPart(p) || isPdfDataPart(p));
}

/**
 * Extract non-image parts from a message (original shapes preserved).
 */
export function getNonImageParts(
    message: vscode.LanguageModelChatRequestMessage,
): vscode.LanguageModelInputPart[] {
    return (message.content as readonly vscode.LanguageModelInputPart[]).filter(
        (part) => !isImageDataPart(part),
    );
}

/**
 * Extract parts that are neither images nor PDFs (original shapes preserved).
 */
export function getNonVisionParts(
    message: vscode.LanguageModelChatRequestMessage,
): vscode.LanguageModelInputPart[] {
    return (message.content as readonly vscode.LanguageModelInputPart[]).filter(
        (part) => !isVisionDataPart(part),
    );
}

// ---------------------------------------------------------------------------
// Tool-result images (screenshots / view_image)
// ---------------------------------------------------------------------------
// In agent mode the model captures pictures via tools (screenshot_page,
// view_image, ...). Copilot returns those images as `LanguageModelDataPart`s
// nested inside a `LanguageModelToolResultPart`'s `content` array — NOT as
// user-attached image parts. The direct-image loop only inspects top-level
// parts, so tool-result images would otherwise be flattened to a bare
// "[image: png, N bytes]" placeholder by the transform and the model never
// sees the picture. These helpers locate and rebuild such images.

/** A reference to one image nested inside a tool-result part's content. */
export interface ToolResultImageRef {
    /** Index of the LanguageModelToolResultPart within the message content. */
    toolIndex: number;
    /** Index of the image part inside the tool result's `content` array. */
    partIndex: number;
    /** The normalized image part (`{ data, mimeType }`). */
    image: DataPartLike;
}

/**
 * Structural tool-result check — deliberately NO `instanceof` (patched-bundle
 * parts cross an extension-host realm; see normalizeDataPart). A tool result
 * has a string `callId` plus an array `content` (or `output`) — unlike a tool
 * CALL part (callId + `input` object).
 */
export function isToolResultPart(part: unknown): boolean {
    if (typeof part !== 'object' || part === null) return false;
    const p = part as { callId?: unknown; content?: unknown; output?: unknown };
    if (typeof p.callId !== 'string') return false;
    return Array.isArray(p.content) || Array.isArray(p.output);
}

/** Read a tool result's inner content array (`.content`, fallback `.output`). */
export function getToolResultContent(part: unknown): readonly unknown[] {
    const p = part as { content?: unknown; output?: unknown };
    if (Array.isArray(p.content)) return p.content;
    if (Array.isArray(p.output)) return p.output;
    return [];
}

/**
 * Rebuild a tool result part whose content has been edited, preserving its
 * `callId` and `isError`. Always produced as a real `LanguageModelToolResultPart`
 * so the transform's `instanceof` checks keep working.
 */
export function rebuildToolResultPart(
    part: unknown,
    newContent: readonly unknown[],
): vscode.LanguageModelToolResultPart {
    const p = part as { callId?: unknown; isError?: unknown };
    const rebuilt = new vscode.LanguageModelToolResultPart(
        typeof p.callId === 'string' ? p.callId : '',
        [...newContent],
    );
    if (p.isError === true) {
        (rebuilt as { isError?: boolean }).isError = true;
    }
    return rebuilt;
}

/**
 * Extract all image data parts nested inside tool-result parts in a message,
 * returning their locations so they can be replaced with descriptions.
 */
export function getToolResultImageParts(
    message: vscode.LanguageModelChatRequestMessage,
): ToolResultImageRef[] {
    const refs: ToolResultImageRef[] = [];
    const content = message.content as readonly vscode.LanguageModelInputPart[];
    for (const [toolIndex, part] of content.entries()) {
        if (!isToolResultPart(part)) continue;
        const inner = getToolResultContent(part);
        for (const [partIndex, innerPart] of inner.entries()) {
            const norm = normalizeDataPart(innerPart);
            if (norm && norm.mimeType.toLowerCase().startsWith('image/')) {
                refs.push({ toolIndex, partIndex, image: norm });
            }
        }
    }
    return refs;
}

/**
 * Extract text from a message's text parts.
 */
export function getMessageText(
    message: vscode.LanguageModelChatRequestMessage,
): string {
    let text = '';
    for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            text += part.value;
        }
    }
    return text;
}

/**
 * Structural data-part check — deliberately NO `instanceof` (matches
 * src/transform/messages.ts isDataPart). PDF/image parts created by the
 * patched Copilot bundle cross an extension-host realm, so
 * `part instanceof vscode.LanguageModelDataPart` is unreliable: the part
 * arrives as a plain `{ data: Uint8Array, mimeType: string }` object
 * (observed 2026-08-09 — text extraction worked, vision skipped the PDF).
 */
/**
 * Structural data-part check — deliberately NO `instanceof` (matches
 * src/transform/messages.ts isDataPart). PDF/image parts created by the
 * patched Copilot bundle cross an extension-host realm, so
 * `part instanceof vscode.LanguageModelDataPart` is unreliable: the part
 * arrives as a plain object (observed 2026-08-09 — text extraction worked,
 * vision skipped the PDF).
 */

/** A data part normalized to the canonical `{ data, mimeType }` shape. */
export interface DataPartLike {
    data: Uint8Array;
    mimeType: string;
}

/**
 * Normalize ANY data-part shape into `{ data: Uint8Array, mimeType }`.
 *
 * Parts arrive in several shapes depending on the path that produced them
 * (all observed with the patched Copilot bundle):
 *   - `{ data: Uint8Array, mimeType }`                    — LanguageModelDataPart-ish
 *   - `{ data: base64-string, mimeType }`                 — serialized data part
 *   - `{ data: Uint8Array|string, mediaType }`            — Lu.Document agent path (P7)
 *   - `{ documentData: { data, mediaType } }`             — unconverted Document part (P5 source)
 * Returns undefined for anything that is not a binary data part.
 */
export function normalizeDataPart(part: unknown): DataPartLike | undefined {
    if (typeof part !== 'object' || part === null) return undefined;
    const p = part as {
        data?: unknown;
        mimeType?: unknown;
        mediaType?: unknown;
        documentData?: unknown;
    };
    let data: unknown = p.data;
    let mime: unknown = p.mimeType ?? p.mediaType;
    if (p.documentData && typeof p.documentData === 'object') {
        const dd = p.documentData as { data?: unknown; mediaType?: unknown; mimeType?: unknown };
        data = dd.data;
        mime = dd.mimeType ?? dd.mediaType;
    }
    if (typeof mime !== 'string' || mime.length === 0) return undefined;
    if (data instanceof Uint8Array) {
        return { data, mimeType: mime };
    }
    if (data instanceof ArrayBuffer) {
        return { data: new Uint8Array(data), mimeType: mime };
    }
    if (typeof data === 'string') {
        try {
            return { data: new Uint8Array(Buffer.from(data, 'base64')), mimeType: mime };
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function isDataPartLike(part: unknown): part is DataPartLike {
    return normalizeDataPart(part) !== undefined;
}

export function isImageDataPart(part: unknown): part is DataPartLike {
    const norm = normalizeDataPart(part);
    return norm !== undefined && norm.mimeType.toLowerCase().startsWith('image/');
}

/**
 * PDF data parts (application/pdf) — vision-eligible when the describer
 * supports documents (Gemini direct API), otherwise handled by the local
 * text-extraction fallback in vscodeMessagesToDeepSeek.
 */
export function isPdfDataPart(part: unknown): part is DataPartLike {
    const norm = normalizeDataPart(part);
    return norm !== undefined && isPdfMime(norm.mimeType);
}

/** Any data part the vision pipeline may handle: images or PDFs. */
export function isVisionDataPart(part: unknown): part is DataPartLike {
    return isImageDataPart(part) || isPdfDataPart(part);
}

/**
 * Create the wrapped description text: `[Image Description: <text>]`
 */
export function createImageDescriptionText(description: string): string {
    return IMAGE_DESCRIPTION_PREFIX + description + IMAGE_DESCRIPTION_SUFFIX;
}

/**
 * Format a non-empty text + vision text combination.
 * If there's existing text, separate with a newline. Otherwise return just the vision text.
 */
export function createVisionReplayText(
    visionText: string,
    nonImageParts: readonly vscode.LanguageModelInputPart[],
): string {
    const hasText = nonImageParts.some(
        (part) => part instanceof vscode.LanguageModelTextPart && part.value.trim().length > 0,
    );
    const separatedText = hasText ? `\n\n${visionText}` : visionText;
    return toWellFormedString(separatedText);
}

/**
 * Ensure a string has no invalid surrogate pairs (well-formed Unicode).
 */
function toWellFormedString(value: string): string {
    // Polyfill for String.prototype.toWellFormed() (ES2024)
    // Remove lone surrogates
    return value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
}

// ---------------------------------------------------------------------------
// Encoding / decoding
// ---------------------------------------------------------------------------

function encodeReplayMarkerJson(value: object): string {
    const json = JSON.stringify(value);
    // Base64url-encode (no padding)
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function decodeReplayMarkerPayload(payloadRaw: string): ReplayMarkerParseResult {
    try {
        // Base64url-decode
        const base64 = payloadRaw
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
        const json = new TextDecoder().decode(
            new Uint8Array(atob(padded).split('').map(c => c.charCodeAt(0))),
        );
        const obj = JSON.parse(json);

        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
            return { valid: false, error: 'payload-not-object' };
        }

        const result: ReplayMarkerParseResult = { valid: true };

        // Parse vision
        const vision = obj.vision;
        if (vision !== undefined) {
            if (typeof vision !== 'object' || vision === null || Array.isArray(vision)) {
                result.visionTextIgnoredReason = 'vision-not-object';
            } else if (typeof vision.text !== 'string') {
                result.visionTextIgnoredReason = 'vision-text-not-string';
            } else if (vision.text.length === 0) {
                result.visionTextIgnoredReason = 'vision-text-empty';
            } else {
                result.visionText = vision.text;
            }
        }

        // Parse reasoning
        const reasoning = obj.reasoning;
        if (reasoning !== undefined) {
            if (typeof reasoning !== 'object' || reasoning === null || Array.isArray(reasoning)) {
                result.reasoningTextIgnoredReason = 'reasoning-not-object';
            } else if (typeof reasoning.text !== 'string') {
                result.reasoningTextIgnoredReason = 'reasoning-text-not-string';
            } else if (reasoning.text.length === 0) {
                result.reasoningTextIgnoredReason = 'reasoning-text-empty';
            } else {
                result.reasoningText = reasoning.text;
            }
        }

        // Parse optional segmentId
        if (typeof obj.segmentId === 'string') {
            result.segmentId = obj.segmentId;
        }

        return result;
    } catch (err) {
        visionLog.warn('Failed to decode replay marker', err);
        return { valid: false, error: `decode-error: ${err instanceof Error ? err.message : String(err)}` };
    }
}
