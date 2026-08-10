import * as zlib from 'zlib';

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
 *   1. `extractPdfTextWithPdfjs` — primary extractor using pdfjs-dist (the
 *      same engine VS Code/Copilot use). Handles CID-keyed fonts, ToUnicode
 *      CMaps, Hebrew/RTL, ligatures, etc. — everything the minimal extractor
 *      cannot.
 *   2. `extractPdfTextLegacy` — dependency-light fallback that handles the
 *      common case of simple text-based PDFs (FlateDecode streams + Tj/TJ
 *      operators). Used if pdfjs-dist fails to load/parse or returns nothing.
 *
 * Neither path depends on `vscode`, so both can be unit-tested in plain Node
 * (see test-pdf-e2e.js).
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

let pdfjsApiPromise: Promise<PdfJsApi | undefined> | undefined;

/**
 * Lazily load pdfjs-dist (ESM) via dynamic import so the module stays
 * loadable even in plain-Node test contexts. Returns undefined if the
 * dependency is missing or fails to load.
 */
function loadPdfJs(): Promise<PdfJsApi | undefined> {
    if (!pdfjsApiPromise) {
        pdfjsApiPromise = (async () => {
            try {
                const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
                return (mod as unknown as { default?: PdfJsApi }).default ?? (mod as unknown as PdfJsApi);
            } catch {
                return undefined; // fall back to the legacy extractor
            }
        })();
    }
    return pdfjsApiPromise;
}

/**
 * Extract text from a PDF using pdfjs-dist. Returns '' when nothing could
 * be extracted (scanned/image-only pages, or load failure).
 */
export async function extractPdfTextWithPdfjs(data: Uint8Array): Promise<string> {
    const api = await loadPdfJs();
    if (!api) return '';

    let doc: PdfJsDocument | undefined;
    try {
        doc = await api.getDocument({
            data,
            isEvalSupported: false,      // no eval in the extension host
            disableFontFace: true,       // we only need text, not rendering
            useSystemFonts: true,
            verbosity: 0,                // keep logs quiet
        }).promise;

        const chunks: string[] = [];
        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
            const page = await doc.getPage(pageNum);
            const tc = await page.getTextContent();
            if (tc.items.length) {
                chunks.push(tc.items.map(item => item.str).join(' '));
            }
        }
        return chunks.join('\n').trim();
    } catch {
        return ''; // fall back to the legacy extractor
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
 * falling back to the minimal stream-operator extractor.
 */
export async function extractPdfText(data: Uint8Array): Promise<string> {
    const fromPdfjs = await extractPdfTextWithPdfjs(data);
    if (fromPdfjs) return fromPdfjs;
    return extractPdfTextLegacy(data);
}

/**
 * Wrap extracted PDF text for inclusion as a DeepSeek text content part.
 * If nothing could be extracted, returns a short notice instead so the user
 * knows the attachment was seen but not machine-readable.
 */
export async function pdfDataToTextContent(data: Uint8Array): Promise<string> {
    const text = await extractPdfText(data);
    if (text) {
        return `[Attached PDF contents:\n${text}\n]`;
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
