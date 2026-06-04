/**
 * Gemini vision API — free tier image description.
 *
 * Uses Google AI Studio's free tier (Gemini 2.5 Flash).
 * API key is obtained from: https://aistudio.google.com/apikey
 *
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

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

export interface VisionResult {
    description: string;
    success: boolean;
    error?: string;
}

/**
 * Describe a single image using Gemini 2.5 Flash (free tier).
 */
export async function describeImage(
    imageData: Uint8Array,
    mimeType: string,
    apiKey: string,
    prompt?: string
): Promise<VisionResult> {
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

    const url = `${GEMINI_API_BASE}?key=${encodeURIComponent(apiKey)}`;

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
