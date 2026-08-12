import { safeStringify } from '../api/sanitize.js';
import { usageTracker } from '../usage/tracker.js';
import type { VisionResult } from './types.js';

/**
 * Gemini vision API — image description using Google AI Studio.
 *
 * API key is obtained from: https://aistudio.google.com/apikey
 *
 * Supports multiple Gemini models via the modelName parameter.
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiRequest {
    contents: GeminiContent[];
    generationConfig?: {
        temperature?: number;
        maxOutputTokens?: number;
    };
}

interface GeminiContent {
    role?: 'user' | 'model';
    parts: GeminiPart[];
}

interface GeminiPart {
    text?: string;
    inlineData?: {
        mimeType: string;
        data: string; // base64
    };
}

interface GeminiResponse {
    candidates?: GeminiCandidate[];
    error?: { message: string; code: number };
}

interface GeminiCandidate {
    content?: {
        parts?: { text?: string }[];
    };
    finishReason?: string;
}

export type { VisionResult };

/**
 * Describe a single image or PDF document using a Gemini model.
 *
 * Gemini handles `application/pdf` inline data natively (including scanned
 * PDFs), so the same call covers both images and documents.
 *
 * @param imageData Raw attachment bytes
 * @param mimeType MIME type (e.g. 'image/png' or 'application/pdf')
 * @param apiKey Google AI Studio API key
 * @param modelName Gemini model name (default: 'gemini-2.5-flash')
 * @param prompt Optional custom prompt
 */
export async function describeImage(
    imageData: Uint8Array,
    mimeType: string,
    apiKey: string,
    modelName: string = 'gemini-2.5-flash',
    prompt?: string
): Promise<VisionResult> {
    const startedAt = Date.now();
    const base64Data = Buffer.from(imageData).toString('base64');

    const request: GeminiRequest = {
        contents: [
            {
                role: 'user',
                parts: [
                    {
                        text: prompt ?? 'Please describe this image in detail. Include all relevant visual information such as text, code, UI elements, diagrams, charts, people, objects, colors, layout, and any other notable details. Be thorough and precise.',
                    },
                    {
                        inlineData: {
                            mimeType,
                            data: base64Data,
                        },
                    },
                ],
            },
        ],
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024,
        },
    };

    const url = `${GEMINI_API_BASE}/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeStringify(request),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            return {
                description: '',
                success: false,
                error: `Gemini API error ${response.status}: ${errorBody}`,
            };
        }

        const data = (await response.json()) as GeminiResponse;

        if (data.error) {
            return {
                description: '',
                success: false,
                error: `Gemini API error: ${data.error.message}`,
            };
        }

        const description = data.candidates?.[0]?.content?.parts
            ?.map(p => p.text ?? '')
            .join('')
            .trim();

        if (!description) {
            return {
                description: '',
                success: false,
                error: 'Gemini returned no description text',
            };
        }

        // Account for the vision sub-call in the usage dashboard (additive
        // observer — a failure here must never break the vision result).
        try {
            usageTracker.record({
                provider: 'vision',
                model: modelName,
                promptTokens: Math.ceil(((prompt?.length ?? 0) + base64Data.length / 1.4) / 4),
                completionTokens: Math.ceil(description.length / 4),
                timestamp: Date.now(),
                latencyMs: Date.now() - startedAt,
            });
        } catch { /* never break vision */ }

        return { description, success: true };
    } catch (err) {
        return {
            description: '',
            success: false,
            error: `Gemini vision request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/**
 * Describe multiple images. Processes images sequentially to avoid rate limiting.
 */
export async function describeImages(
    images: { data: Uint8Array; mimeType: string }[],
    apiKey: string
): Promise<VisionResult[]> {
    const results: VisionResult[] = [];

    for (const img of images) {
        const result = await describeImage(img.data, img.mimeType, apiKey);
        results.push(result);
    }

    return results;
}
