import * as zlib from 'zlib';
import { log } from '../log.js';

/**
 * PDF text extraction for DeepSeek content parts.
 *
 * DeepSeek's API does NOT support file/document inputs — the Responses API
 * guide explicitly states image and file inputs are not supported (they are
 * replaced with a placeholder), and file tools are ignored. So the only way
 * to get PDF content to DeepSeek is to extract the PDF's text locally and
 * send it as a regular text part.
 *
 * Strategy (defense in depth):
 *   1. `extractPdfTextWithPdfjs` — primary extractor using pdfjs-dist v3
 *      (CJS/UMD build loaded via `require()`). Handles CID-keyed fonts,
 *      ToUnicode CMaps, Hebrew/RTL, ligatures, etc. — everything the
 *      minimal extractor cannot.
 *   2. `extractPdfTextLegacy` — dependency-light fallback that handles the
 *      common case of simple text-based PDFs (FlateDecode streams + Tj/TJ
 *      operators). Used if pdfjs-dist fails to load/parse or returns nothing.
 *
 * WHY v3 UMD and not v4 ESM: the v4 package is ESM-only and must be loaded
 * with dynamic `import()`. In the extension host that import silently
 * failed (2026-08-10, v0.7.19), so every PDF fell back to the legacy
 * extractor and Hebrew/CID PDFs came out as symbol garbage. The v3 UMD
 * build loads synchronously with `require()` in any extension host.
 *
 * Worker wiring (v0.7.21): pdfjs v3's Node fake-worker loader runs
 * `eval("require")(GlobalWorkerOptions.workerSrc)`, which throws in the
 * extension host when workerSrc is unset. We register the worker module on
 * `globalThis.pdfjsWorker` instead, switching pdfjs to its in-process
 * main-thread handler — no eval, no workerSrc, no dynamic import.
 */

/** True for `application/pdf` (and lenient wildcard `*` + `/pdf`). */
export function isPdfMime(mimeType: string): boolean {
    const m = (mimeType || '').toLowerCase();
    return m === 'application/pdf' || m.endsWith('/pdf');
}

// ── pdfjs-dist types (subset we use) ───────────────────────────────────
interface PdfJsTextItem { str: string; }
interface PdfJsTextContent { items: PdfJsTextItem[]; }
interface PdfJsPage { getTextContent(): Promise<PdfJsTextContent>; }
interface PdfJsDocument {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfJsPage>;
    destroy(): void;
}
interface PdfJsApi {
    getDocument(params: {
        data: Uint8Array;
        isEvalSupported?: boolean;
        disableFontFace?: boolean;
        useSystemFonts?: boolean;
        verbosity?: number;
    }): { promise: Promise<PdfJsDocument> };
}

let pdfjsApi: PdfJsApi | undefined;
let pdfjsLoadFailed = false;

/**
 * Load pdfjs-dist v3 (CJS/UMD) synchronously via `require()`.
 * Returns undefined if the dependency is missing or fails to load — the
 * failure is logged ONCE so silent fallbacks to the (garbling) legacy
 * extractor are diagnosable.
 */
function loadPdfJs(): PdfJsApi | undefined {
    if (pdfjsApi === undefined && !pdfjsLoadFailed) {
        try {
            pdfjsApi = require('pdfjs-dist/legacy/build/pdf.js') as PdfJsApi;
            // Register the worker on the main thread (Node mode). pdfjs then
            // uses its in-process "main thread" worker handler and never runs
            // the fake-worker loader, which does
            //   eval("require")(GlobalWorkerOptions.workerSrc)
            // and throws ERR_INVALID_ARG_TYPE in the extension host when
            // workerSrc is unset (2026-08-10, v0.7.20) — making getDocument
            // reject and silently falling back to the garbling legacy
            // extractor (590-char symbol soup for Hebrew PDFs).
            try {
                const worker = require('pdfjs-dist/legacy/build/pdf.worker.js') as { WorkerMessageHandler?: unknown };
                (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
            } catch { /* worker optional for text extraction */ }
        } catch (err) {
            pdfjsLoadFailed = true;
            log.error(`[PDF] pdfjs-dist failed to load (falling back to minimal extractor): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return pdfjsApi;
}

/** Options controlling which pages of a PDF are extracted. */
export interface PdfExtractOptions {
    /** 1-based inclusive page range to extract (e.g. {start: 10, end: 20}). */
    pageRange?: { start: number; end: number };
    /** Max pages to extract when no explicit range is given (0 = unlimited). */
    maxPages?: number;
}

/**
 * Detect a page-range request in a user message.
 *
 * Understands English and Hebrew:
 *   - "read pages 100-150" / "page 3" / "pages 5 to 12"
 *   - "עמודים 100-150" / "עמוד 3" / "קרא עמודים 5 עד 12"
 *
 * Returns a 1-based inclusive range, or undefined when no explicit range
 * is present (the caller then applies its max-pages cap).
 */
export function detectPageRange(text: string): { start: number; end: number } | undefined {
    if (!text) return undefined;

    // English: pages 100-150 | page 3 | pages 5 to 12 | pages 10 until 20
    const enRange = /page[s]?\s*:?\s*(\d+)(?:\s*[-–—]\s*(\d+)|\s+(?:to|until)\s+(\d+)|\s+עד\s+(\d+))?/i.exec(text);
    // Hebrew: עמודים 100-150 | עמוד 3 | עמודים 5 עד 12 | קרא עמודים 5 עד 12
    const heRange = /עמוד(?:ים)?\s*:?\s*(\d+)(?:\s*[-–—]\s*(\d+)|\s+עד\s+(\d+))?/.exec(text);

    const m = enRange ?? heRange;
    if (!m) return undefined;

    const start = parseInt(m[1], 10);
    if (!Number.isFinite(start) || start < 1) return undefined;
    const endRaw = m[2] ?? m[3] ?? m[4];
    if (endRaw) {
        const end = parseInt(endRaw, 10);
        if (Number.isFinite(end) && end >= start) {
            return { start, end };
        }
    }
    // Single page.
    return { start, end: start };
}

/** Result of a page-aware extraction. */
export interface PdfExtractResult {
    text: string;
    totalPages: number;
    /** 1-based pages actually extracted (may be a subset due to range/cap). */
    pagesIncluded: number;
    /** True when the PDF has more pages than were extracted (range/cap applied). */
    truncated: boolean;
}

/**
 * Extract text from a PDF using pdfjs-dist, optionally limited to a page
 * range or a max page count. Returns '' when nothing could be extracted
 * (scanned/image-only pages, or load failure).
 */
export async function extractPdfTextWithPdfjs(
    data: Uint8Array,
    options?: PdfExtractOptions,
): Promise<PdfExtractResult> {
    const empty: PdfExtractResult = { text: '', totalPages: 0, pagesIncluded: 0, truncated: false };
    const api = loadPdfJs();
    if (!api) return empty;

    let doc: PdfJsDocument | undefined;
    try {
        doc = await api.getDocument({
            data,
            isEvalSupported: false,      // no eval in the extension host
            disableFontFace: true,       // we only need text, not rendering
            useSystemFonts: true,
            verbosity: 0,                // keep logs quiet
        }).promise;

        const totalPages = doc.numPages;

        // Determine the page set to extract.
        let start = 1;
        let end = totalPages;
        if (options?.pageRange) {
            start = Math.max(1, options.pageRange.start);
            end = Math.min(totalPages, options.pageRange.end);
            if (start > end) return { ...empty, totalPages };
        } else if (options?.maxPages && options.maxPages > 0 && totalPages > options.maxPages) {
            end = Math.min(totalPages, options.maxPages);
        }

        const chunks: string[] = [];
        for (let pageNum = start; pageNum <= end; pageNum++) {
            const page = await doc.getPage(pageNum);
            const tc = await page.getTextContent();
            if (tc.items.length) {
                chunks.push(tc.items.map(item => item.str).join(' '));
            }
        }
        const text = chunks.join('\n').trim();
        const pagesIncluded = end - start + 1;
        return {
            text,
            totalPages,
            pagesIncluded,
            truncated: pagesIncluded < totalPages,
        };
    } catch (err) {
        // Log the real reason — this is where the extension host has been
        // failing silently (v0.7.19/v0.7.20), producing garbage from the
        // legacy fallback.
        log.error(`[PDF] pdfjs extraction failed: ${err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` : String(err)}`);
        return empty; // fall back to the legacy extractor
    } finally {
        try { doc?.destroy(); } catch { /* ignore */ }
    }
}

/**
 * Extract human-readable text from a PDF's content streams (minimal,
 * dependency-free extractor). Returns '' when nothing could be extracted.
 *
 * Handles the common case of text-based PDFs:
 *   - Locates every `stream ... endstream` block (content streams).
 *   - Inflates FlateDecode-compressed streams (the default for most PDFs).
 *   - Extracts text from the PDF text-showing operators `Tj`, `'`, `"`, and
 *     `TJ`, decoding the parenthesised string literals (escapes + octal).
 *
 * Limitations (degrade gracefully to an empty string):
 *   - Scanned/image-only PDFs have no text layer → nothing to extract.
 *   - CID-keyed fonts with custom encodings may extract garbled text
 *     (pdfjs-dist path handles those).
 *   - Non-FlateDecode filters (e.g. LZW, ASCIIHex) are not decoded.
 */
export function extractPdfTextLegacy(data: Uint8Array): string {
    try {
        const content = Buffer.from(data).toString('latin1');
        const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
        const chunks: string[] = [];
        let match: RegExpExecArray | null;

        while ((match = streamRe.exec(content)) !== null) {
            const raw = Buffer.from(match[1], 'latin1');
            let decoded: Buffer;
            try {
                // Most PDFs compress content streams with FlateDecode.
                decoded = zlib.inflateSync(raw);
            } catch {
                decoded = raw; // not compressed (or another filter) — use as-is
            }

            const text = extractTextOperators(decoded.toString('latin1'));
            if (text) chunks.push(text);
        }

        return chunks.join('\n').trim();
    } catch {
        return '';
    }
}

/**
 * Extract text from a PDF: pdfjs-dist first (handles CID/ToUnicode/Hebrew),
 * falling back to the minimal stream-operator extractor. Page-aware — a page
 * range or max-page cap can be supplied for large documents.
 */
export async function extractPdfText(
    data: Uint8Array,
    options?: PdfExtractOptions,
): Promise<string> {
    const fromPdfjs = await extractPdfTextWithPdfjs(data, options);
    if (fromPdfjs.text) {
        log.info(
            `[PDF] pdfjs extractor: ${fromPdfjs.text.length} chars ` +
            `(pages ${fromPdfjs.pagesIncluded}/${fromPdfjs.totalPages}${fromPdfjs.truncated ? ', truncated' : ''})`
        );
        return fromPdfjs.text;
    }
    const fromLegacy = extractPdfTextLegacy(data);
    log.info(`[PDF] legacy extractor: ${fromLegacy.length} chars (pdfjs returned nothing)`);
    return fromLegacy;
}

/**
 * Wrap extracted PDF text for inclusion as a DeepSeek text content part.
 * If nothing could be extracted, returns a short notice instead so the user
 * knows the attachment was seen but not machine-readable.
 *
 * Large PDFs are capped via `maxPages` (unless a page range is supplied);
 * when truncated, the model is told how many pages exist and that it can ask
 * for a specific range.
 */
export async function pdfDataToTextContent(
    data: Uint8Array,
    options?: PdfExtractOptions & { pageNotice?: boolean },
): Promise<string> {
    // First pass: extract with the requested options (range or cap).
    const result = await extractPdfTextWithPdfjs(data, options);
    if (result.text) {
        const notice = options?.pageNotice && result.truncated
            ? `\n\n[Note: this PDF has ${result.totalPages} pages. Only the first ${result.pagesIncluded} were extracted to fit the context window. ` +
              `Ask for a specific range, e.g. "read pages 100-150", to see those pages.]`
            : '';
        log.info(
            `[PDF] data part mime=${'application/pdf'} bytes=${data.byteLength} → ` +
            `text (${result.text.length} chars, pages ${result.pagesIncluded}/${result.totalPages})`
        );
        return `[Attached PDF contents:\n${result.text}\n]${notice}`;
    }

    // pdfjs returned nothing — fall back to the legacy extractor, then the
    // no-text notice.
    const fromLegacy = extractPdfTextLegacy(data);
    if (fromLegacy) {
        log.info(`[PDF] legacy extractor: ${fromLegacy.length} chars (pdfjs returned nothing)`);
        return `[Attached PDF contents:\n${fromLegacy}\n]`;
    }
    return '[Attached PDF: no extractable text (scanned or image-based PDF).]';
}

/**
 * Extract text from PDF text-showing operators in a (decoded) content stream:
 *   (string) Tj | (string) ' | (string) " | [ (a) 10 (b) ] TJ
 */
function extractTextOperators(decoded: string): string {
    const out: string[] = [];

    // Single-string operators: Tj, ', "
    const singleRe = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g;
    let m: RegExpExecArray | null;
    while ((m = singleRe.exec(decoded)) !== null) {
        out.push(decodePdfString(m[1]));
    }

    // Array operator: TJ (contains strings interleaved with kerning numbers)
    const tjRe = /\[([\s\S]*?)\]\s*TJ/g;
    while ((m = tjRe.exec(decoded)) !== null) {
        const strRe = /\(((?:\\.|[^\\()])*)\)/g;
        let s: RegExpExecArray | null;
        while ((s = strRe.exec(m[1])) !== null) {
            out.push(decodePdfString(s[1]));
        }
    }

    return out.join('');
}

/** Decode a PDF string literal: \n \r \t \b \f \( \) \\ and octal escapes. */
function decodePdfString(raw: string): string {
    return raw.replace(/\\([nrtbf()\\])|\\\d{1,3}|\\/g, (esc, char: string | undefined) => {
        if (char) {
            switch (char) {
                case 'n': return '\n';
                case 'r': return '\r';
                case 't': return '\t';
                case 'b': return '\b';
                case 'f': return '\f';
                default: return char;
            }
        }
        if (/^\\\d{1,3}$/.test(esc)) {
            return String.fromCharCode(parseInt(esc.slice(1), 8));
        }
        return '';
    });
}
