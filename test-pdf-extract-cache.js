// test-pdf-extract-cache.js — mirrors src/pdf/extractCache.ts (v0.7.86).
// Pure module — no vscode dependency.
const assert = require('assert');
const {
    EXTRACT_CACHE_MAX,
    MAX_CACHED_CHARS,
    setPdfExtractCacheEnabled,
    isPdfExtractCacheEnabled,
    pdfExtractCacheKey,
    pdfExtractCacheGet,
    pdfExtractCacheSet,
    clearPdfExtractCache,
    pdfExtractCacheSize,
} = require('./out/pdf/extractCache.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        setPdfExtractCacheEnabled(true);
        clearPdfExtractCache();
        fn();
        passed++;
    } catch (e) {
        failed++;
        console.error(`  FAIL: ${name}\n    ${e.message}`);
    }
}

function bytes(len) {
    const b = new Uint8Array(len);
    for (let i = 0; i < len; i++) b[i] = (i * 31 + 7) & 0xff;
    return b;
}

// --- enabled flag ---
check('default enabled', () => {
    assert.strictEqual(isPdfExtractCacheEnabled(), true);
});
check('setPdfExtractCacheEnabled(false) disables get/set', () => {
    setPdfExtractCacheEnabled(false);
    const key = pdfExtractCacheKey(bytes(100));
    pdfExtractCacheSet(key, { text: 'x', totalPages: 1, pagesIncluded: 1, truncated: false });
    assert.strictEqual(pdfExtractCacheGet(key), undefined);
    assert.strictEqual(pdfExtractCacheSize(), 0);
});

// --- round-trip ---
check('set then get round-trips', () => {
    const key = pdfExtractCacheKey(bytes(100));
    pdfExtractCacheSet(key, { text: 'hello', totalPages: 5, pagesIncluded: 5, truncated: false });
    const got = pdfExtractCacheGet(key);
    assert.ok(got);
    assert.strictEqual(got.text, 'hello');
    assert.strictEqual(got.totalPages, 5);
});

// --- key: same bytes → same key; different bytes → different key ---
check('key stable for identical bytes', () => {
    assert.strictEqual(pdfExtractCacheKey(bytes(100)), pdfExtractCacheKey(bytes(100)));
});
check('key differs for different bytes', () => {
    const a = new Uint8Array(100).fill(1);
    const b = new Uint8Array(100).fill(2);
    assert.notStrictEqual(pdfExtractCacheKey(a), pdfExtractCacheKey(b));
});
check('key differs by length', () => {
    assert.notStrictEqual(pdfExtractCacheKey(bytes(100)), pdfExtractCacheKey(bytes(101)));
});

// --- key: options differentiate ---
check('options change the key', () => {
    const k1 = pdfExtractCacheKey(bytes(100), { maxPages: 5 });
    const k2 = pdfExtractCacheKey(bytes(100), { maxPages: 10 });
    assert.notStrictEqual(k1, k2);
    const k3 = pdfExtractCacheKey(bytes(100), { pageRange: { start: 1, end: 3 } });
    assert.notStrictEqual(k1, k3);
});

// --- LRU cap eviction ---
check('LRU cap evicts oldest', () => {
    for (let i = 0; i < EXTRACT_CACHE_MAX + 3; i++) {
        const b = new Uint8Array(64);
        b[0] = i;
        pdfExtractCacheSet(pdfExtractCacheKey(b), { text: `r${i}`, totalPages: 1, pagesIncluded: 1, truncated: false });
    }
    assert.ok(pdfExtractCacheSize() <= EXTRACT_CACHE_MAX, `size ${pdfExtractCacheSize()}`);
});

// --- oversized results skipped ---
check('oversized results not cached', () => {
    const key = pdfExtractCacheKey(bytes(100));
    pdfExtractCacheSet(key, { text: 'x'.repeat(MAX_CACHED_CHARS + 10), totalPages: 1, pagesIncluded: 1, truncated: false });
    assert.strictEqual(pdfExtractCacheGet(key), undefined);
});

// --- LRU refresh keeps recently-used ---
check('LRU refresh keeps most recently used', () => {
    // Insert A, then B (A evicts first when over cap). Touch A, insert C.
    const kb = (v) => { const b = new Uint8Array(64); b[0] = v; return b; };
    const kA = pdfExtractCacheKey(kb(1));
    const kB = pdfExtractCacheKey(kb(2));
    const kC = pdfExtractCacheKey(kb(3));
    pdfExtractCacheSet(kA, { text: 'A', totalPages: 1, pagesIncluded: 1, truncated: false });
    pdfExtractCacheSet(kB, { text: 'B', totalPages: 1, pagesIncluded: 1, truncated: false });
    pdfExtractCacheGet(kA); // touch A → A becomes newest
    for (let i = 0; i < EXTRACT_CACHE_MAX - 1; i++) {
        pdfExtractCacheSet(pdfExtractCacheKey(kb(100 + i)), { text: 'x', totalPages: 1, pagesIncluded: 1, truncated: false });
    }
    assert.ok(pdfExtractCacheGet(kA), 'A survives (refreshed)');
});

// --- never throws ---
check('set/get never throw on weird input', () => {
    pdfExtractCacheSet('', { text: 'x', totalPages: 1, pagesIncluded: 1, truncated: false });
    pdfExtractCacheSet(pdfExtractCacheKey(bytes(10)), null);
    assert.strictEqual(pdfExtractCacheGet(''), undefined);
    assert.strictEqual(pdfExtractCacheGet('missing'), undefined);
});

// --- clear ---
check('clear empties the cache', () => {
    const key = pdfExtractCacheKey(bytes(50));
    pdfExtractCacheSet(key, { text: 'x', totalPages: 1, pagesIncluded: 1, truncated: false });
    clearPdfExtractCache();
    assert.strictEqual(pdfExtractCacheSize(), 0);
    assert.strictEqual(pdfExtractCacheGet(key), undefined);
});

console.log(`\ntest-pdf-extract-cache: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
