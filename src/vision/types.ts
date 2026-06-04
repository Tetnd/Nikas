/**
 * Shared vision types used by all vision providers (Gemini, Gemma 4, etc.).
 */

export interface VisionResult {
    description: string;
    success: boolean;
    error?: string;
}
