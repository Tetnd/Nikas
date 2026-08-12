/**
 * Sparse-PDF vision description cache (v0.7.83).
 *
 * PURE + vscode-free (unit-testable from plain Node, see test-pdf-vision-cache.js).
 *
 * Why: the provider re-sends the full history every turn, so without a cache
 * the same sparse PDF would be re-described via the vision model on EVERY
 * request (slow + costly). Keying by (prompt + mimeType + content hash) means
 * an unchanged PDF is described once and served from cache on subsequent turns.
 *
 * Fully ADDITIVE + guarded: a miss falls through to a normal describe; a bad
 * key never throws. Bounded to avoid unbounded memory.
 */

const CACHE_MAX = 64;
const cache = new Map<string, string>();

/** Cheap deterministic hash of a string/buffer (cache keys only). */
export function simpleHashBytes(input: Uint8Array | string | undefined | null): string {
    if (input === undefined || input === null) return 'none';
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        h1 = (h1 ^ c) * 0x01000193;
        h2 = (h2 ^ c) * 0x85ebca6b;
    }
    return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).slice(0, 16);
}

/** Build the cache key for a sparse-PDF describe call. */
export function pdfDescribeCacheKey(prompt: string, mimeType: string, data: Uint8Array): string {
    try {
        return `${simpleHashBytes(prompt)}|${String(mimeType)}|${simpleHashBytes(data)}`;
    } catch {
        return `${String(prompt)}|${String(mimeType)}|${String(data?.byteLength ?? 0)}`;
    }
}

/** Get a cached description, or undefined on miss. Never throws. */
export function pdfDescribeCacheGet(key: string): string | undefined {
    try {
        return cache.get(key);
    } catch {
        return undefined;
    }
}

/** Store a description, evicting the oldest entry if over the cap. */
export function pdfDescribeCacheSet(key: string, description: string): void {
    try {
        cache.set(key, String(description));
        if (cache.size > CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
    } catch { /* cache must never break the request */ }
}

/** Clear the sparse-PDF description cache. */
export function clearPdfDescribeCache(): void {
    cache.clear();
}

/** Number of cached entries (diagnostics / tests). */
export function pdfDescribeCacheSize(): number {
    return cache.size;
}
