/**
 * Image-vision batching helpers (v0.7.85) — PURE + vscode-free.
 *
 * Vision models cap the number of images per request (Gemini ~16; we use a
 * conservative 8). When a user message carries more images than the cap, the
 * pipeline describes them in sequential chunks and combines the results.
 *
 * Also hosts the structured image-extraction prompt (v0.7.85) so tests can
 * assert on it without importing the vscode-dependent pipeline.
 */

import { IMAGE_DESCRIPTION_PROMPT_STRUCTURED } from './consts.js';

/** Max images per vision-model call (conservative; Gemini allows ~16). */
export const MAX_IMAGES_PER_VISION_CALL = 8;

/** Structured OCR/layout extraction prompt used for image describes. */
export function getStructuredImageVisionPrompt(): string {
    return IMAGE_DESCRIPTION_PROMPT_STRUCTURED;
}

/**
 * Split an image list into sequential chunks of at most `chunkSize`.
 * Returns a single-element array when under the cap (no batching needed).
 */
export function chunkImages<T>(images: readonly T[], chunkSize = MAX_IMAGES_PER_VISION_CALL): T[][] {
    const size = Math.max(1, Math.floor(chunkSize));
    const chunks: T[][] = [];
    for (let i = 0; i < images.length; i += size) {
        chunks.push(images.slice(i, i + size));
    }
    return chunks;
}

/**
 * Combine per-chunk vision descriptions into one text, preserving order.
 * Empty chunks are skipped. Single-chunk results pass through unchanged.
 */
export function combineImageDescriptions(descriptions: readonly string[]): string {
    const nonEmpty = descriptions.filter((d) => d && d.trim().length > 0);
    if (nonEmpty.length === 0) return '';
    if (nonEmpty.length === 1) return nonEmpty[0];
    const parts = nonEmpty.map((d, i) => `[Image group ${i + 1}/${nonEmpty.length}]\n${d.trim()}`);
    return parts.join('\n\n');
}
