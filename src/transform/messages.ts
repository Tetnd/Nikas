import * as vscode from 'vscode';
import { log } from '../log.js';
import { safeStringify } from '../api/sanitize.js';
import { isPdfMime, pdfDataToTextContent } from '../pdf/extract.js';
import { parseReplayMarkerData, REPLAY_MARKER_MIME } from '../vision/replay.js';
import type { DeepSeekMessage, DeepSeekContentPart, DeepSeekResponsesInputItem } from '../api/types.js';

/**
 * Convert VS Code LanguageModelChatRequestMessage[] to DeepSeek API message format.
 *
 * VS Code messages contain parts:
 *   - LanguageModelTextPart → text content
 *   - LanguageModelDataPart → images (Uint8Array + mimeType)
 *   - LanguageModelToolCallPart → assistant tool calls
 *   - LanguageModelToolResultPart → tool results (in user messages)
 */

export function vscodeMessagesToDeepSeek(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
): DeepSeekMessage[] {
    return messages.flatMap(msg => vscodeMessageToDeepSeek(msg));
}

/**
 * Convert a single VS Code message to one or more DeepSeek messages.
 *
 * One VS Code message can produce multiple DeepSeek messages because
 * a User message may contain multiple LanguageModelToolResultParts,
 * each of which must become a separate role: "tool" message.
 */
function vscodeMessageToDeepSeek(
    msg: vscode.LanguageModelChatRequestMessage
): DeepSeekMessage[] {
    // If content is a string, it's a simple message
    if (typeof msg.content === 'string') {
        const role = mapRole(msg.role);
        return [{ role, content: msg.content, name: msg.name }];
    }

    const parts = msg.content as readonly vscode.LanguageModelInputPart[];

    // Detect message type from parts
    const hasToolResults = parts.some(p => p instanceof vscode.LanguageModelToolResultPart);
    const hasToolCalls = parts.some(p => p instanceof vscode.LanguageModelToolCallPart);

    if (hasToolCalls) {
        // Assistant message with tool calls
        return [buildAssistantToolCallMessage(parts, msg.name)];
    }

    if (hasToolResults) {
        // Tool results come in User messages but must become role: "tool" messages
        return buildToolResultMessages(parts);
    }

    // Regular user/assistant message with text and/or images
    const role = mapRole(msg.role);
    const contentParts = buildContentParts(parts);

    if (contentParts.length === 0) {
        return [{ role, content: '', name: msg.name }];
    }

    const built: DeepSeekMessage = { role, content: contentParts, name: msg.name };

    // If this is an assistant message carrying a replay marker with reasoning
    // (thinking-mode CoT captured on a previous turn), round-trip it so the
    // API doesn't return HTTP 400 on the tools+thinking path.
    if (role === 'assistant') {
        const reasoning = extractReasoningFromParts(parts);
        if (reasoning) built.reasoning_content = reasoning;
    }

    return [built];
}

/**
 * Extract the thinking-mode reasoning text from a replay marker part, if any.
 * The marker is a LanguageModelDataPart with MIME `stateful_marker` carrying
 * `{ reasoning: { text } }` metadata. Returns undefined when absent.
 */
function extractReasoningFromParts(parts: readonly vscode.LanguageModelInputPart[]): string | undefined {
    for (const part of parts) {
        if (!(part instanceof vscode.LanguageModelDataPart)) continue;
        if (part.mimeType !== REPLAY_MARKER_MIME) continue;
        const marker = parseReplayMarkerData(part.data);
        if (marker.valid && marker.reasoningText) {
            return marker.reasoningText;
        }
    }
    return undefined;
}

/**
 * Build an assistant message with tool_calls.
 */
function buildAssistantToolCallParts(
    parts: readonly vscode.LanguageModelInputPart[]
): { toolCalls: NonNullable<DeepSeekMessage['tool_calls']>; textContent: string[] } {
    const toolCalls: NonNullable<DeepSeekMessage['tool_calls']> = [];
    const textContent: string[] = [];

    for (const part of parts) {
        if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push({
                id: part.callId,
                type: 'function',
                function: {
                    name: part.name,
                    arguments: safeStringify(part.input),
                },
            });
        } else if (part instanceof vscode.LanguageModelTextPart) {
            textContent.push(part.value);
        }
    }

    return { toolCalls, textContent };
}

/** @deprecated Replay markers superseded this — see vision/replay.ts and vision/pipeline.ts */
export function injectVisionDescriptions(
    messages: DeepSeekMessage[],
    descriptions: Map<number, string>
): DeepSeekMessage[] {
    return messages.map((msg, i) => {
        const desc = descriptions.get(i);
        if (desc) {
            let originalText = '';
            if (typeof msg.content === 'string') {
                originalText = msg.content;
            } else if (Array.isArray(msg.content)) {
                originalText = msg.content
                    .filter(p => p.type === 'text')
                    .map(p => (p as { type: 'text'; text: string }).text)
                    .join('\n');
            }
            const prefix = originalText ? originalText + '\n\n' : '';
            return {
                ...msg,
                content: `${prefix}[The user attached an image. Its contents are described below:\n${desc}]`,
            };
        }
        return msg;
    });
}

/** @deprecated Replay markers superseded this — see vision/replay.ts */
export function extractImageParts(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
): Map<number, { data: Uint8Array; mimeType: string }[]> {
    const result = new Map<number, { data: Uint8Array; mimeType: string }[]>();
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (typeof msg.content === 'string') continue;
        const parts = msg.content as readonly vscode.LanguageModelInputPart[];
        for (const part of parts) {
            if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                const entry = result.get(i) ?? [];
                entry.push({ data: part.data, mimeType: part.mimeType });
                result.set(i, entry);
            }
        }
    }
    return result;
}

/** @deprecated Replay markers superseded this — see vision/replay.ts */
export function hasImageParts(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
): boolean {
    for (const msg of messages) {
        if (typeof msg.content === 'string') continue;
        for (const part of msg.content as readonly vscode.LanguageModelInputPart[]) {
            if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Convert DeepSeek chat-completion messages to Responses API input items.
 *
 * Mapping (per DeepSeek Responses API docs):
 * - system            → top-level `instructions` (first one) or `message` item
 * - user              → `message` item (role: user)
 * - assistant (text)  → `message` item (role: assistant)
 * - assistant (tools) → adjacent `function_call` items
 * - tool (result)     → `function_call_output` item
 *
 * Images were already resolved to text by the vision pipeline before this
 * point, so any leftover image_url parts are dropped (the Responses API would
 * replace them with placeholders anyway).
 *
 * Returns `{ input, instructions }` — `instructions` is the first system
 * message, hoisted to the top-level request field per the API docs.
 */
export function deepseekMessagesToResponsesInput(
    messages: DeepSeekMessage[]
): { input: DeepSeekResponsesInputItem[]; instructions?: string } {
    const input: DeepSeekResponsesInputItem[] = [];
    let instructions: string | undefined;

    for (const msg of messages) {
        if (msg.role === 'system') {
            const text = messageText(msg);
            if (!instructions && text) {
                instructions = text;
            } else {
                input.push({ type: 'message', role: 'system', content: text });
            }
            continue;
        }

        if (msg.role === 'user') {
            input.push({ type: 'message', role: 'user', content: messageText(msg) });
            continue;
        }

        if (msg.role === 'assistant') {
            // Thinking mode + tools: DeepSeek REQUIRES the assistant's
            // reasoning_text to be passed back as an input item right before
            // the message / function_call it belongs to (HTTP 400 otherwise).
            if (msg.reasoning_content) {
                input.push({
                    type: 'reasoning_text',
                    text: msg.reasoning_content,
                });
            }
            const text = messageText(msg);
            if (text) {
                input.push({ type: 'message', role: 'assistant', content: text });
            }
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    input.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    });
                }
            }
            continue;
        }

        if (msg.role === 'tool' && msg.tool_call_id) {
            input.push({
                type: 'function_call_output',
                call_id: msg.tool_call_id,
                output: messageText(msg),
            });
            continue;
        }
    }

    return { input, instructions };
}

/** Extract plain text from a DeepSeek message (string or content parts). */
function messageText(msg: DeepSeekMessage): string {
    if (typeof msg.content === 'string') {
        return msg.content;
    }
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((p): p is DeepSeekContentPart & { type: 'text'; text: string } =>
                p.type === 'text' && !!p.text)
            .map(p => p.text)
            .join('\n');
    }
    return '';
}

// --- Helpers ---

/**
 * Build an assistant message from tool call parts (with optional text).
 */
function buildAssistantToolCallMessage(
    parts: readonly vscode.LanguageModelInputPart[],
    name?: string
): DeepSeekMessage {
    const { toolCalls, textContent } = buildAssistantToolCallParts(parts);

    const msg: DeepSeekMessage = {
        role: 'assistant',
        content: textContent.length > 0 ? textContent.join('\n') : null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    // Thinking mode + tools: DeepSeek REQUIRES the assistant's reasoning_text
    // to be passed back, or it returns HTTP 400. Round-trip it from the marker.
    const reasoning = extractReasoningFromParts(parts);
    if (reasoning) msg.reasoning_content = reasoning;

    if (name) msg.name = name;
    return msg;
}

/**
 * Build one or more role: "tool" messages from LanguageModelToolResultParts.
 * DeepSeek requires each tool result to be its own message with matching tool_call_id.
 */
function buildToolResultMessages(
    parts: readonly vscode.LanguageModelInputPart[]
): DeepSeekMessage[] {
    const messages: DeepSeekMessage[] = [];

    for (const part of parts) {
        if (part instanceof vscode.LanguageModelToolResultPart) {
            const content = part.content
                .map(p => (p instanceof vscode.LanguageModelTextPart ? p.value : ''))
                .join('\n');

            messages.push({
                role: 'tool',
                tool_call_id: part.callId,
                content: content || '',
            });
        }
        // Non-tool-result parts in a tool-result message are unusual but we include them as user text
        else if (part instanceof vscode.LanguageModelTextPart) {
            messages.push({ role: 'user', content: part.value });
        }
    }

    return messages;
}

/**
 * Build DeepSeek content parts from text / image / PDF parts (no tool parts).
 *
 * PDF handling: DeepSeek's API does NOT accept file/document inputs, so an
 * `application/pdf` data part is converted to a TEXT part carrying the
 * PDF's extracted contents (see src/pdf/extract.ts). Images become
 * `image_url` data URIs, text passes through.
 */
export function buildContentParts(
    parts: readonly vscode.LanguageModelInputPart[]
): DeepSeekContentPart[] {
    const contentParts: DeepSeekContentPart[] = [];

    for (const part of parts) {
        if (isTextPart(part)) {
            contentParts.push({ type: 'text', text: part.value });
        } else if (isDataPart(part)) {
            if (isImageMime(part.mimeType)) {
                const dataUri = uint8ArrayToDataUri(part.data, part.mimeType);
                contentParts.push({
                    type: 'image_url',
                    image_url: { url: dataUri },
                });
            } else if (isPdfMime(part.mimeType)) {
                // DeepSeek cannot ingest the PDF binary — send its text instead.
                const text = pdfDataToTextContent(part.data);
                log.info(`[PDF] data part mime=${part.mimeType} bytes=${part.data.byteLength} → text (${text.length} chars)`);
                contentParts.push({ type: 'text', text });
            } else {
                // Diagnosability: a data part we don't recognize is silently
                // dropped — log it so attachment losses are visible.
                log.info(`[PDF] UNKNOWN data part dropped: mime=${part.mimeType} bytes=${part.data.byteLength}`);
            }
        }
    }

    return contentParts;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): DeepSeekMessage['role'] {
    switch (role) {
        case vscode.LanguageModelChatMessageRole.User:
            return 'user';
        case vscode.LanguageModelChatMessageRole.Assistant:
            return 'assistant';
        default:
            return 'user';
    }
}

/** Structural checks (no `instanceof`) so the core logic is testable in Node. */
function isTextPart(part: unknown): part is { value: string } {
    return typeof part === 'object' && part !== null && typeof (part as { value?: unknown }).value === 'string';
}

function isDataPart(part: unknown): part is { data: Uint8Array; mimeType: string } {
    return typeof part === 'object' && part !== null
        && (part as { data?: unknown }).data instanceof Uint8Array
        && typeof (part as { mimeType?: unknown }).mimeType === 'string';
}

function isImageMime(mimeType: string): boolean {
    return mimeType.toLowerCase().startsWith('image/');
}

function uint8ArrayToDataUri(data: Uint8Array, mimeType: string): string {
    // In VS Code extension context, we can use Buffer
    const base64 = Buffer.from(data).toString('base64');
    return `data:${mimeType};base64,${base64}`;
}
