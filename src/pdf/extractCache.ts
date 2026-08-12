/**
 * PDF text-extraction cache (v0.7.86) — PURE + vscode-free.
 *
 * pdfjs parsing is expensive: a 600-page PDF takes seconds and burns CPU on
 * every request that carries it. This cache keys extraction results by a
 * content hash (first 1KB + length) + the extraction options, so re-attaching
 * the same PDF is served from memory instead of re-parsed.
 *
 * Bounded + conservative:
 *  - LRU cap (default 16 entries).
 *  - Results larger than MAX_CACHED_CHARS (500K) are not stored.
 *  - Enabled flag is settable (extension.ts syncs it from nikas.pdfExtractCache)
 *    so the pure module never imports vscode.
 *  - Never throws.
 */

/** Max entries in the LRU cache. */
export const EXTRACT_CACHE_MAX = 16;
/** Results with more text than this are not cached (memory bound). */
export const MAX_CACHED_CHARS = 500_000;

export interface PdfExtractCacheEntry {
    text: string;
    totalPages: number;
    pagesIncluded: number;
    truncated: boolean;
}

let _enabled = true;
/** Sync from the nikas.pdfExtractCache setting (extension.ts). */
export function setPdfExtractCacheEnabled(enabled: boolean): void {
    _enabled = enabled;
}
export function isPdfExtractCacheEnabled(): boolean {
    return _enabled;
}

const cache = new Map<string, PdfExtractCacheEntry>();

/** Cheap FNV-1a hash of the first 1024 bytes (fast, collision-resistant enough). */
function hashPrefix(data: Uint8Array): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    const len = Math.min(data?.length ?? 0, 1024);
    for (let i = 0; i < len; i++) {
        const c = data[i];
        h1 = (h1 ^ c) * 0x01000193;
        h2 = (h2 ^ c) * 0x85ebca6b;
    }
    return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).slice(0, 16);
}

/** Canonical options fragment for the cache key. */
function optionsFragment(options?: { pageRange?: { start: number; end: number }; maxPages?: number }): string {
    const range = options?.pageRange ? `r${options.pageRange.start}-${options.pageRange.end}` : '';
    const max = options?.maxPages ? `m${options.maxPages}` : '';
    return `${range}|${max}`;
}

/** Build the cache key for a PDF payload + extraction options. */
export function pdfExtractCacheKey(data: Uint8Array, options?: { pageRange?: { start: number; end: number }; maxPages?: number }): string {
    const len = data?.length ?? 0;
    return `${hashPrefix(data)}:${len}:${optionsFragment(options)}`;
}

/** Look up a cached extraction result (undefined on miss). */
export function pdfExtractCacheGet(key: string): PdfExtractCacheEntry | undefined {
    if (!_enabled || !key) return undefined;
    const hit = cache.get(key);
    if (hit !== undefined) {
        // LRU refresh: re-insert at the end.
        cache.delete(key);
        cache.set(key, hit);
    }
    return hit;
}

/** Store an extraction result (bounded LRU; oversized results skipped). */
export function pdfExtractCacheSet(key: string, entry: PdfExtractCacheEntry): void {
    if (!_enabled || !key) return;
    try {
        if ((entry?.text?.length ?? 0) > MAX_CACHED_CHARS) return;
        cache.delete(key);
        cache.set(key, { ...entry });
        if (cache.size > EXTRACT_CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
    } catch { /* never throws */ }
}

/** Clear the cache (tests / diagnostics). */
export function clearPdfExtractCache(): void {
    cache.clear();
}

/** Current cache size (tests / diagnostics). */
export function pdfExtractCacheSize(): number {
    return cache.size;
}
