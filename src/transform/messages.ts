import * as vscode from 'vscode';
import { log } from '../log.js';
import type { DeepSeekMessage, DeepSeekContentPart } from '../api/types.js';

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

    return [{ role, content: contentParts, name: msg.name }];
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
                    arguments: JSON.stringify(part.input),
                },
            });
        } else if (part instanceof vscode.LanguageModelTextPart) {
            textContent.push(part.value);
        }
    }

    return { toolCalls, textContent };
}

/**
 * After vision preprocessing, inject text descriptions back into messages.
 * Replaces image parts with text descriptions.
 * Messages without descriptions that still contain image_url parts are stripped
 * (replaced with a placeholder) so DeepSeek never sees unsupported image_url parts.
 */
export function injectVisionDescriptions(
    messages: DeepSeekMessage[],
    descriptions: Map<number, string> // messageIndex → description text
): DeepSeekMessage[] {
    return messages.map((msg, i) => {
        const desc = descriptions.get(i);
        if (desc) {
            // Extract ALL text from the message — both simple strings and array content parts
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

        // No description for this message — strip any lingering image_url parts
        if (hasImageContent(msg)) {
            return stripImageParts(msg);
        }

        return msg;
    });
}

/**
 * Check if a DeepSeek message contains image_url content parts.
 */
function hasImageContent(msg: DeepSeekMessage): boolean {
    if (!msg.content || typeof msg.content === 'string') return false;
    return msg.content.some(p => p.type === 'image_url');
}

/**
 * Strip image_url parts from a message, leaving only text.
 * Adds a placeholder so the conversation flow isn't broken.
 */
function stripImageParts(msg: DeepSeekMessage): DeepSeekMessage {
    if (!msg.content || typeof msg.content === 'string') return msg;

    const textParts = msg.content
        .filter(p => p.type === 'text')
        .map(p => (p as { type: 'text'; text: string }).text);

    const textContent = textParts.join('\n');
    const placeholder = '[The user attached an image, but the vision model could not process it. You may ask the user to describe it.]';

    return {
        ...msg,
        content: textContent ? `${textContent}\n\n${placeholder}` : placeholder,
    };
}

/**
 * Extract image data parts from messages, indexed by message position.
 * Returns a map of message index → array of { data, mimeType }.
 */
export function extractImageParts(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
): Map<number, { data: Uint8Array; mimeType: string }[]> {
    const result = new Map<number, { data: Uint8Array; mimeType: string }[]>();

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (typeof msg.content === 'string') continue;

        const parts = msg.content as readonly vscode.LanguageModelInputPart[];
        for (const part of parts) {
            if (part instanceof vscode.LanguageModelDataPart && isImagePart(part)) {
                const entry = result.get(i) ?? [];
                entry.push({ data: part.data, mimeType: part.mimeType });
                result.set(i, entry);
            }
        }
    }

    return result;
}

/**
 * Check if any messages contain image parts.
 */
export function hasImageParts(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
): boolean {
    for (const msg of messages) {
        if (typeof msg.content === 'string') continue;
        for (const part of msg.content as readonly vscode.LanguageModelInputPart[]) {
            if (part instanceof vscode.LanguageModelDataPart && isImagePart(part)) {
                return true;
            }
        }
    }
    return false;
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
 * Build DeepSeek content parts from text and image parts (no tool parts).
 */
function buildContentParts(
    parts: readonly vscode.LanguageModelInputPart[]
): DeepSeekContentPart[] {
    const contentParts: DeepSeekContentPart[] = [];

    for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
            contentParts.push({ type: 'text', text: part.value });
        } else if (part instanceof vscode.LanguageModelDataPart) {
            if (isImagePart(part)) {
                const dataUri = uint8ArrayToDataUri(part.data, part.mimeType);
                contentParts.push({
                    type: 'image_url',
                    image_url: { url: dataUri },
                });
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

function isImagePart(part: vscode.LanguageModelDataPart): boolean {
    return part.mimeType.startsWith('image/');
}

function uint8ArrayToDataUri(data: Uint8Array, mimeType: string): string {
    // In VS Code extension context, we can use Buffer
    const base64 = Buffer.from(data).toString('base64');
    return `data:${mimeType};base64,${base64}`;
}
