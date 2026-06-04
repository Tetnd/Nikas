import type { VisionResult } from './types.js';

/**
 * Gemma 4 vision via Ollama — local image description.
 *
 * Uses Ollama's /api/chat endpoint with the gemma4:31b model.
 * No API key required — Ollama runs locally.
 *
 * Endpoint: POST http://localhost:11434/api/chat
 */

interface OllamaChatRequest {
    model: string;
    messages: OllamaMessage[];
    stream: boolean;
    options?: {
        temperature?: number;
        num_predict?: number;
    };
}

interface OllamaMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    images?: string[]; // base64-encoded images
}

interface OllamaChatResponse {
    model: string;
    message?: {
        role: string;
        content: string;
        thinking?: string; // Gemma 4 puts reasoning here, final output in content
    };
    error?: string;
}

/**
 * Describe a single image using Gemma 4 via Ollama.
 */
export async function describeImage(
    imageData: Uint8Array,
    mimeType: string,
    ollamaBaseUrl: string,
    prompt?: string,
    modelName = 'gemma4:31b'
): Promise<VisionResult> {
    const base64Data = Buffer.from(imageData).toString('base64');

    const request: OllamaChatRequest = {
        model: modelName,
        messages: [
            {
                role: 'user',
                content: prompt ?? 'Please describe this image in detail. Include all relevant visual information such as text, code, UI elements, diagrams, charts, people, objects, colors, layout, and any other notable details. Be thorough and precise.',
                images: [base64Data],
            },
        ],
        stream: false,
        options: {
            temperature: 0.1,
            num_predict: 1024,
        },
    };

    const url = `${ollamaBaseUrl.replace(/\/$/, '')}/api/chat`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            return {
                description: '',
                success: false,
                error: `Ollama API error ${response.status}: ${errorBody}`,
            };
        }

        const data = (await response.json()) as OllamaChatResponse;

        if (data.error) {
            return {
                description: '',
                success: false,
                error: `Ollama error: ${data.error}`,
            };
        }

        const description = data.message?.content?.trim() || data.message?.thinking?.trim();

        if (!description) {
            // Dump raw response for debugging
            const rawPreview = JSON.stringify(data).slice(0, 500);
            return {
                description: '',
                success: false,
                error: `Gemma 4 returned no description text. Raw response: ${rawPreview}`,
            };
        }

        return { description, success: true };
    } catch (err) {
        return {
            description: '',
            success: false,
            error: `Gemma 4 vision request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
