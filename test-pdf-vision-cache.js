// test-pdf-vision-cache.js — unit tests for the sparse-PDF vision description cache
// (src/vision/pdfCache.ts) and the sparse-PDF prompt, v0.7.83.
//
// Covers: key derivation (prompt+mime+content sensitive, stable for same input),
// get/set round-trip, bounded LRU eviction, clear, and the never-throws guarantee.

const {
    simpleHashBytes,
    pdfDescribeCacheKey,
    pdfDescribeCacheGet,
    pdfDescribeCacheSet,
    clearPdfDescribeCache,
    pdfDescribeCacheSize,
} = require('./out/vision/pdfCache.js');

// Import the compiled pipeline to read the prompt export. (pipeline.js imports
// vscode, so guard the require so this test still gives useful coverage of the
// cache even if vscode isn't available in plain node.)
let getSparsePdfVisionPrompt = null;
try {
    const pipeline = require('./out/vision/pipeline.js');
    getSparsePdfVisionPrompt = pipeline.getSparsePdfVisionPrompt;
} catch { /* vscode not available in plain node — prompt assertion skipped */ }

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
    if (cond) { passed++; }
    else { failed++; failures.push(name); console.error('  FAIL: ' + name); }
}

const enc = new TextEncoder();

// ── 1. simpleHashBytes ──
{
    assert(typeof simpleHashBytes('abc') === 'string' && simpleHashBytes('abc').length === 16, 'hash returns 16-char hex');
    assert(simpleHashBytes('abc') === simpleHashBytes('abc'), 'hash deterministic');
    assert(simpleHashBytes('abc') !== simpleHashBytes('abd'), 'different input → different hash');
    assert(simpleHashBytes(enc.encode('bytes')) === simpleHashBytes('bytes'), 'string vs bytes hash equal');
    assert(simpleHashBytes('') !== simpleHashBytes('x'), 'empty vs non-empty differ');
}

// ── 2. pdfDescribeCacheKey ──
{
    const data = enc.encode('PDF BINARY CONTENT 123');
    const k1 = pdfDescribeCacheKey('prompt A', 'application/pdf', data);
    const k2 = pdfDescribeCacheKey('prompt A', 'application/pdf', data);
    assert(k1 === k2, 'same input → same key');
    assert(k1.includes('application/pdf'), 'key includes mime');
    const kDiffPrompt = pdfDescribeCacheKey('prompt B', 'application/pdf', data);
    assert(k1 !== kDiffPrompt, 'different prompt → different key');
    const kDiffData = pdfDescribeCacheKey('prompt A', 'application/pdf', enc.encode('DIFFERENT'));
    assert(k1 !== kDiffData, 'different content → different key');
    const kDiffMime = pdfDescribeCacheKey('prompt A', 'image/png', data);
    assert(k1 !== kDiffMime, 'different mime → different key');
}

// ── 3. get/set round-trip ──
{
    clearPdfDescribeCache();
    const key = pdfDescribeCacheKey('p', 'application/pdf', enc.encode('d'));
    assert(pdfDescribeCacheGet(key) === undefined, 'miss → undefined');
    pdfDescribeCacheSet(key, 'the description');
    assert(pdfDescribeCacheGet(key) === 'the description', 'get after set');
    assert(pdfDescribeCacheSize() === 1, 'size 1');
    clearPdfDescribeCache();
    assert(pdfDescribeCacheGet(key) === undefined, 'clear removes entry');
    assert(pdfDescribeCacheSize() === 0, 'size 0 after clear');
}

// ── 4. bounded eviction (CACHE_MAX = 64) ──
{
    clearPdfDescribeCache();
    for (let i = 0; i < 70; i++) {
        pdfDescribeCacheSet('key' + i, 'desc' + i);
    }
    assert(pdfDescribeCacheSize() === 64, 'capped at 64 (' + pdfDescribeCacheSize() + ')');
    assert(pdfDescribeCacheGet('key0') === undefined, 'oldest evicted');
    assert(pdfDescribeCacheGet('key69') === 'desc69', 'newest kept');
    clearPdfDescribeCache();
}

// ── 5. never throws on bad input ──
{
    clearPdfDescribeCache();
    let threw = false;
    try {
        pdfDescribeCacheKey(undefined, undefined, undefined);
        pdfDescribeCacheKey(null, null, null);
        pdfDescribeCacheKey('p', 'application/pdf', null);
        pdfDescribeCacheSet(undefined, undefined);
        pdfDescribeCacheSet('k', null);
        pdfDescribeCacheGet(undefined);
        pdfDescribeCacheGet(null);
        simpleHashBytes(undefined);
    } catch (e) {
        threw = true;
        console.error('  threw: ' + e);
    }
    assert(!threw, 'never throws on bad input');
    clearPdfDescribeCache();
}

// ── 6. sparse-PDF prompt (if vscode was available to import pipeline) ──
if (getSparsePdfVisionPrompt) {
    const prompt = getSparsePdfVisionPrompt();
    assert(typeof prompt === 'string' && prompt.length > 50, 'sparse-PDF prompt is a non-trivial string');
    assert(prompt.includes('table') || prompt.includes('layout') || prompt.includes('transcribe'), 'prompt asks for transcription/structure');
    assert(prompt.toLowerCase().includes('do not invent'), 'prompt guards against hallucination');
} else {
    console.log('  (pipeline.js not importable in plain node — skipped prompt assertions)');
}

console.log('');
console.log(`test-pdf-vision-cache: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('Failures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
