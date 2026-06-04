import * as vscode from 'vscode';
import type { DeepSeekRequest, DeepSeekResponse, DeepSeekDelta, DeepSeekErrorResponse, DeepSeekToolCallDelta } from './types.js';

const DEEPSEEK_API_BASE = 'https://api.deepseek.com';
const DEEPSEEK_CHAT_ENDPOINT = `${DEEPSEEK_API_BASE}/chat/completions`;

/**
 * DeepSeek API client with SSE streaming support.
 *
 * DeepSeek's API is OpenAI-compatible. The endpoint is /chat/completions
 * (NOT /v1/chat/completions).
 */

export async function streamDeepSeekChat(
    request: DeepSeekRequest,
    apiKey: string,
    signal: AbortSignal,
    onText: (text: string) => void,
    onToolCalls: (toolCalls: CompletedToolCall[]) => void,
    onComplete: (usage?: { promptTokens: number; completionTokens: number }) => void
): Promise<void> {
    // Ensure stream options are set
    const streamRequest: DeepSeekRequest = {
        ...request,
        stream: true,
        stream_options: { include_usage: true },
    };

    const response = await fetch(DEEPSEEK_CHAT_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'text/event-stream',
        },
        body: JSON.stringify(streamRequest),
        signal,
    });

    if (!response.ok) {
        await handleErrorResponse(response);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('No response body reader available');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const pendingToolCalls = new Map<number, PendingToolCall>();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;

                const data = trimmed.slice(6); // Remove "data: " prefix
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data) as DeepSeekResponse;
                    for (const choice of parsed.choices) {
                        const delta = choice.delta;
                        if (!delta) continue;

                        // Handle text content
                        if (delta.content) {
                            onText(delta.content);
                        }

                        // Handle tool calls (streamed in chunks)
                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                mergeToolCallDelta(pendingToolCalls, tc);
                            }
                        }

                        // Check for finished tool calls
                        if (choice.finish_reason === 'tool_calls') {
                            const completed = finalizeToolCalls(pendingToolCalls);
                            if (completed.length > 0) {
                                onToolCalls(completed);
                            }
                        }
                    }

                    // Track usage from final chunk
                    if (parsed.usage) {
                        onComplete({
                            promptTokens: parsed.usage.prompt_tokens,
                            completionTokens: parsed.usage.completion_tokens,
                        });
                    }
                } catch {
                    // Skip unparseable SSE lines
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

// --- Tool Call State Management ---

interface PendingToolCall {
    id: string;
    name: string;
    arguments: string;
}

interface CompletedToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

function mergeToolCallDelta(
    pending: Map<number, PendingToolCall>,
    delta: DeepSeekToolCallDelta
): void {
    const existing = pending.get(delta.index) ?? { id: '', name: '', arguments: '' };

    if (delta.id) existing.id = delta.id;
    if (delta.function?.name) existing.name += delta.function.name;
    if (delta.function?.arguments) existing.arguments += delta.function.arguments;

    pending.set(delta.index, existing);
}

function finalizeToolCalls(pending: Map<number, PendingToolCall>): CompletedToolCall[] {
    const results: CompletedToolCall[] = [];

    for (const [, tc] of pending) {
        try {
            results.push({
                id: tc.id,
                name: tc.name,
                arguments: JSON.parse(tc.arguments),
            });
        } catch {
            // Skip tool calls with invalid JSON arguments
        }
    }

    pending.clear();
    return results;
}

// --- Error Handling ---

async function handleErrorResponse(response: Response): Promise<never> {
    let message = `DeepSeek API returned ${response.status}`;

    try {
        const body = await response.json() as DeepSeekErrorResponse;
        if (body.error?.message) {
            message = `DeepSeek API error: ${body.error.message}`;
        }
    } catch {
        try {
            const text = await response.text();
            if (text) message += `: ${text}`;
        } catch {
            // ignore
        }
    }

    switch (response.status) {
        case 401:
            message = 'Invalid DeepSeek API key. Run "Nika: Input Deepseek userToken" to update it.';
            break;
        case 429:
            message = 'DeepSeek API rate limit exceeded. Please wait and try again.';
            break;
        case 500:
        case 502:
        case 503:
            message = 'DeepSeek service is temporarily unavailable. Please try again later.';
            break;
    }

    throw new Error(message);
}

// --- Non-Streaming (for key validation) ---

export async function validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const response = await fetch(DEEPSEEK_CHAT_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'deepseek-v4-flash',
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 1,
                stream: false,
            }),
        });

        if (response.ok) {
            return { valid: true };
        }

        if (response.status === 401) {
            return { valid: false, error: 'Invalid API key' };
        }

        return { valid: false, error: `API returned status ${response.status}` };
    } catch (err) {
        return {
            valid: false,
            error: err instanceof Error ? err.message : 'Network error connecting to DeepSeek API',
        };
    }
}
