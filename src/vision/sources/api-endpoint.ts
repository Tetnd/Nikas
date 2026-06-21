import * as vscode from 'vscode';
import { visionLog } from '../log.js';
import type { VisionDescriber, VisionDescriptionRequest, VisionProxySource } from '../types.js';
import { IMAGE_DESCRIPTION_PROMPT } from '../consts.js';

/**
 * Generic API endpoint vision describer.
 *
 * Supports OpenAI /chat/completions, OpenAI /responses, and Anthropic /messages
 * protocols. Configured via a URL, API key, model ID, optional headers, and
 * extra body fields.
 */

export type ApiEndpointProviderFamily = 'anthropic-compatible' | 'openai-compatible';
export type ApiEndpointApiType = 'messages' | 'chat-completions' | 'responses';

export interface ApiEndpointConfig {
    providerFamily: ApiEndpointProviderFamily;
    apiType: ApiEndpointApiType;
    url: string;
    modelId: string;
    apiKey?: string;
    headers?: Record<string, string>;
    extraBody?: Record<string, unknown>;
}

export class ApiEndpointVisionDescriber implements VisionDescriber {
    readonly source: VisionProxySource = 'api-endpoint';

    constructor(
        public readonly id: string,
        private readonly config: ApiEndpointConfig,
    ) {}

    async describe(request: VisionDescriptionRequest): Promise<string> {
        if (request.token.isCancellationRequested) {
            throw new ApiEndpointError('cancelled', 'Request was cancelled');
        }

        const body = this.createBody(request);
        const headers = this.createHeaders();
        const url = this.config.url;

        visionLog.info(`Describing ${request.images.length} image(s) via ${url}`);

        // Create an AbortController from the CancellationToken
        const abortController = new AbortController();
        const cancelListener = request.token.onCancellationRequested(() => {
            abortController.abort();
        });

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: abortController.signal,
            });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new ApiEndpointError(
                'http-error',
                `API returned ${response.status}: ${errorBody}`,
            );
        }

            const result = await response.json();
            return this.parseResponse(result);
        } finally {
            cancelListener.dispose();
        }
    }

    private createBody(request: VisionDescriptionRequest): object {
        switch (this.config.apiType) {
            case 'messages':
                return this.createAnthropicBody(request);
            case 'responses':
                return this.createOpenAIResponsesBody(request);
            default:
                return this.createOpenAIChatBody(request);
        }
    }

    private createAnthropicBody(request: VisionDescriptionRequest): object {
        return {
            max_tokens: 1024,
            ...this.config.extraBody,
            model: this.config.modelId,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: request.prompt },
                        ...request.images.map((image) => ({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: image.mimeType,
                                data: toBase64(image.data),
                            },
                        })),
                    ],
                },
            ],
        };
    }

    private createOpenAIChatBody(request: VisionDescriptionRequest): object {
        return {
            ...this.config.extraBody,
            model: this.config.modelId,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: request.prompt },
                        ...request.images.map((image) => ({
                            type: 'image_url',
                            image_url: {
                                url: `data:${image.mimeType};base64,${toBase64(image.data)}`,
                            },
                        })),
                    ],
                },
            ],
        };
    }

    private createOpenAIResponsesBody(request: VisionDescriptionRequest): object {
        return {
            ...this.config.extraBody,
            model: this.config.modelId,
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: request.prompt },
                        ...request.images.map((image) => ({
                            type: 'input_image',
                            detail: 'auto',
                            image_url: `data:${image.mimeType};base64,${toBase64(image.data)}`,
                        })),
                    ],
                },
            ],
        };
    }

    private createHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.config.headers,
        };

        if (this.config.apiKey) {
            if (this.config.providerFamily === 'anthropic-compatible') {
                headers['x-api-key'] = this.config.apiKey;
                headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
            } else {
                headers['Authorization'] = `Bearer ${this.config.apiKey}`;
            }
        }

        return headers;
    }

    private parseResponse(value: unknown): string {
        if (this.config.providerFamily === 'anthropic-compatible') {
            return this.parseAnthropicResponse(value);
        }
        if (this.config.apiType === 'responses') {
            return this.parseOpenAIResponsesResponse(value);
        }
        return this.parseOpenAIChatResponse(value);
    }

    private parseAnthropicResponse(value: unknown): string {
        const data = value as Record<string, unknown>;
        if (!data || !Array.isArray(data.content)) {
            throw new ApiEndpointError(
                'unsupported-response',
                'Anthropic response missing content array',
            );
        }

        const text = data.content
            .map((block: unknown) => {
                const b = block as Record<string, unknown>;
                return b.type === 'text' ? b.text : undefined;
            })
            .filter((item): item is string => typeof item === 'string')
            .join('')
            .trim();

        if (!text) {
            throw new ApiEndpointError('empty-response', 'Anthropic returned empty response');
        }
        return text;
    }

    private parseOpenAIChatResponse(value: unknown): string {
        const data = value as Record<string, unknown>;
        const choices = data.choices as Array<Record<string, unknown>> | undefined;
        if (!choices || choices.length === 0) {
            throw new ApiEndpointError(
                'unsupported-response',
                'OpenAI response missing choices',
            );
        }

        const message = choices[0].message as Record<string, unknown> | undefined;
        const content = message?.content as string | undefined;
        if (!content?.trim()) {
            throw new ApiEndpointError('empty-response', 'OpenAI returned empty response');
        }
        return content.trim();
    }

    private parseOpenAIResponsesResponse(value: unknown): string {
        const data = value as Record<string, unknown>;
        const output = data.output as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(output)) {
            throw new ApiEndpointError(
                'unsupported-response',
                'OpenAI Responses response missing output array',
            );
        }

        return output
            .map((item) => {
                if (typeof item.text === 'string') return item.text;
                if (typeof item.content === 'string') return item.content;
                if (Array.isArray(item.content)) {
                    return item.content
                        .map((c: unknown) => {
                            const part = c as Record<string, unknown>;
                            return typeof part.text === 'string' ? part.text : undefined;
                        })
                        .filter((t): t is string => typeof t === 'string')
                        .join('');
                }
                return undefined;
            })
            .filter((item): item is string => typeof item === 'string')
            .join('');
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function toBase64(data: Uint8Array): string {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

export class ApiEndpointError extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'ApiEndpointError';
    }
}

/**
 * Test a vision endpoint connection by sending a minimal PNG.
 */
export async function testApiEndpointConnection(
    config: ApiEndpointConfig,
): Promise<{ ok: boolean; errorCode?: string; message?: string; response?: string }> {
    // A tiny 1x1 transparent PNG as a test image
    const TEST_PNG_BASE64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const TEST_PROMPT = 'Describe what you see in this image. Reply with one word.';

    const describer = new ApiEndpointVisionDescriber('test', config);
    try {
        const description = await describer.describe({
            prompt: TEST_PROMPT,
            images: [
                {
                    mimeType: 'image/png',
                    data: Buffer.from(TEST_PNG_BASE64, 'base64'),
                },
            ],
            token: new vscode.CancellationTokenSource().token,
        });
        return { ok: true, response: description };
    } catch (err) {
        if (err instanceof ApiEndpointError) {
            return { ok: false, errorCode: err.code, message: err.message };
        }
        return {
            ok: false,
            errorCode: 'unknown',
            message: err instanceof Error ? err.message : String(err),
        };
    }
}
