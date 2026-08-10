// E2E test: PDF text extraction → DeepSeek content parts.
//
// Generates a real (minimal but valid) PDF whose content stream is
// FlateDecode-compressed, then verifies:
//   1. extractPdfText() recovers the embedded text from the compressed stream
//   2. pdfDataToTextContent() wraps it as an [Attached PDF contents:...] block
//   3. isPdfMime() accepts application/pdf and lenient * /pdf
//   4. buildContentParts() (the real messages.ts logic) turns an
//      application/pdf data part into a {type:'text'} part with the PDF text,
//      while images still become image_url parts
//   5. Scanned / image-only PDFs fall back to the "no extractable text" notice
//
// Run:  node test-pdf-e2e.js

const zlib = require('zlib');

// ── Load the real compiled modules ─────────────────────────────────────
const { isPdfMime, extractPdfText, pdfDataToTextContent } = require('./out/pdf/extract.js');

// messages.js imports `vscode` at the top, but buildContentParts() only uses
// structural checks (no instanceof), so we stub the vscode module object and
// intercept the require so the real logic can run in plain Node.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return { /* stub — buildContentParts never touches it */ };
    }
    return originalLoad.apply(this, arguments);
};
const { buildContentParts } = require('./out/transform/messages.js');

// ── Minimal PDF builder ────────────────────────────────────────────────
// Builds a valid one-page PDF with a FlateDecode content stream containing
// the given text-showing operators.
function buildPdf(contentOps) {
    const stream = zlib.deflateSync(Buffer.from(contentOps, 'latin1'));
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n${stream.toString('latin1')}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    for (let i = 0; i < objects.length; i++) {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefPos = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
        pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
}

// ── Test harness ───────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

async function main() {

// 1. isPdfMime
console.log('\n[isPdfMime]');
check('application/pdf → true', isPdfMime('application/pdf') === true);
check('APPLICATION/PDF (case) → true', isPdfMime('APPLICATION/PDF') === true);
check('application/x-pdf → false (ends -pdf not /pdf)', isPdfMime('application/x-pdf') === false);
check('foo/pdf → true', isPdfMime('foo/pdf') === true);
check('image/png → false', isPdfMime('image/png') === false);
check('empty → false', isPdfMime('') === false);
check('undefined → false', isPdfMime(undefined) === false);

// 2. Extract text from a real compressed PDF
console.log('\n[extractPdfText]');
const ops = 'BT /F1 24 Tf 72 720 Td (Hello PDF World!) Tj 0 -28 Td (Second line: 42) Tj ET';
const pdfBytes = buildPdf(ops);
const extracted = await extractPdfText(new Uint8Array(pdfBytes));
check('extracts Tj text', extracted.includes('Hello PDF World!'));
check('extracts second line', extracted.includes('Second line: 42'));
check('is a non-empty string', typeof extracted === 'string' && extracted.length > 0);

// 3. TJ array operator (kerning interleaved)
const opsTj = 'BT /F1 12 Tf 72 720 Td [(Array) 10 (Text) -5 (Here)] TJ ET';
const extractedTj = await extractPdfText(new Uint8Array(buildPdf(opsTj)));
check('extracts TJ array text', extractedTj.includes('ArrayTextHere'));

// 4. pdfDataToTextContent wrapper
console.log('\n[pdfDataToTextContent]');
const wrapped = await pdfDataToTextContent(new Uint8Array(pdfBytes));
check('contains marker', wrapped.includes('[Attached PDF contents:'));
check('contains extracted text', wrapped.includes('Hello PDF World!'));
check('closes marker', wrapped.trim().endsWith(']'));

// 5. Scanned PDF (no text operators) → fallback notice
const scannedPdf = buildPdf('q 0.9 0.9 0.9 rg 0 0 612 792 re f Q'); // just draws a gray box
const scannedText = await pdfDataToTextContent(new Uint8Array(scannedPdf));
check('scanned fallback notice', scannedText.includes('no extractable text'));

// 6. buildContentParts end-to-end (real messages.ts logic)
console.log('\n[buildContentParts E2E]');
const parts = [
    { value: 'Please read this PDF' },                                    // text part
    { data: new Uint8Array(pdfBytes), mimeType: 'application/pdf' },      // PDF data part
    { data: new Uint8Array(Buffer.from('fake-png-bytes')), mimeType: 'image/png' }, // image
    { data: new Uint8Array(Buffer.from('notpdf')), mimeType: 'text/plain' },        // ignored non-image non-pdf
];
const contentParts = await buildContentParts(parts);

check('returns parts for text+pdf+image', contentParts.length === 3);
const pdfPart = contentParts.find(p => p.type === 'text' && p.text.includes('Attached PDF contents'));
check('PDF became text part', !!pdfPart);
check('PDF text embedded', pdfPart && pdfPart.text.includes('Hello PDF World!'));
const imgPart = contentParts.find(p => p.type === 'image_url');
check('image still image_url', !!imgPart && imgPart.image_url.url.startsWith('data:image/png;base64,'));
check('plain prompt text preserved', contentParts.some(p => p.type === 'text' && p.text === 'Please read this PDF'));
check('text/plain data ignored', !contentParts.some(p => p.text && p.text.includes('notpdf')));

// 7. buildContentParts with a scanned PDF attachment → notice text part
console.log('\n[buildContentParts scanned fallback]');
const scannedParts = await buildContentParts([
    { value: 'what is in this?' },
    { data: new Uint8Array(scannedPdf), mimeType: 'application/pdf' },
]);
const noticePart = scannedParts.find(p => p.type === 'text' && p.text.includes('no extractable text'));
check('scanned PDF → notice text part', !!noticePart);

// 8. buildContentParts with alternate attachment shapes (patched-bundle
// parts cross the extension-host realm — data may be a base64 string,
// mime may be `mediaType`, or the part may be an unconverted Document
// wrapped in `documentData`). All must normalize to PDF text.
console.log('\n[buildContentParts shape variants]');
const altParts = [
    { value: 'read this' },
    { data: new Uint8Array(pdfBytes), mediaType: 'application/pdf' },
    { data: Buffer.from(pdfBytes).toString('base64'), mediaType: 'application/pdf' },
    { documentData: { data: new Uint8Array(pdfBytes), mediaType: 'application/pdf' } },
    { documentData: { data: Buffer.from(pdfBytes).toString('base64'), mediaType: 'application/pdf' } },
];
const altContent = await buildContentParts(altParts);
const altPdfParts = altContent.filter(p => p.type === 'text' && p.text.includes('Attached PDF contents'));
check('all 4 shape variants converted to PDF text', altPdfParts.length === 4);
check('shape-variant text embedded', altPdfParts.every(p => p.text.includes('Hello PDF World!')));

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
