import * as zlib from 'zlib';

/**
 * Minimal, dependency-free PDF text extraction.
 *
 * DeepSeek's API does NOT support file/document inputs — the Responses API
 * guide explicitly states image and file inputs are not supported (they are
 * replaced with a placeholder), and file tools are ignored. So the only way
 * to get PDF content to DeepSeek is to extract the PDF's text locally and
 * send it as a regular text part.
 *
 * This module implements a small text extractor that handles the common
 * case of text-based PDFs:
 *   - Locates every `stream ... endstream` block (content streams).
 *   - Inflates FlateDecode-compressed streams (the default for most PDFs).
 *   - Extracts text from the PDF text-showing operators `Tj`, `'`, `"`, and
 *     `TJ`, decoding the parenthesised string literals (escapes + octal).
 *
 * It intentionally has no dependency on `vscode`, so it can be unit-tested
 * in plain Node (see test-pdf-e2e.js).
 *
 * Limitations (degrade gracefully to an empty string / a notice):
 *   - Scanned/image-only PDFs have no text layer → nothing to extract.
 *   - CID-keyed fonts with custom encodings may extract garbled text.
 *   - Non-FlateDecode filters (e.g. LZW, ASCIIHex) are not decoded.
 */

/** True for `application/pdf` (and lenient wildcard `*` + `/pdf`). */
export function isPdfMime(mimeType: string): boolean {
    const m = (mimeType || '').toLowerCase();
    return m === 'application/pdf' || m.endsWith('/pdf');
}

/**
 * Extract human-readable text from a PDF's content streams.
 * Returns '' when nothing could be extracted.
 */
export function extractPdfText(data: Uint8Array): string {
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
 * Wrap extracted PDF text for inclusion as a DeepSeek text content part.
 * If nothing could be extracted, returns a short notice instead so the user
 * knows the attachment was seen but not machine-readable.
 */
export function pdfDataToTextContent(data: Uint8Array): string {
    const text = extractPdfText(data);
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
