// test-image-vision.js — mirrors src/vision/imageBatch.ts + the structured
// image prompt (v0.7.85). Pure module — no vscode dependency.
const assert = require('assert');
const {
    MAX_IMAGES_PER_VISION_CALL,
    getStructuredImageVisionPrompt,
    chunkImages,
    combineImageDescriptions,
} = require('./out/vision/imageBatch.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failed++;
        console.error(`  FAIL: ${name}\n    ${e.message}`);
    }
}

// --- constant ---
check('default max images per call is 8', () => {
    assert.strictEqual(MAX_IMAGES_PER_VISION_CALL, 8);
});

// --- chunkImages ---
check('empty list → no chunks', () => {
    assert.deepStrictEqual(chunkImages([]), []);
});
check('under cap → single chunk', () => {
    const imgs = Array.from({ length: 3 }, (_, i) => i);
    assert.deepStrictEqual(chunkImages(imgs), [[0, 1, 2]]);
});
check('exactly cap → single chunk', () => {
    const imgs = Array.from({ length: 8 }, (_, i) => i);
    assert.deepStrictEqual(chunkImages(imgs), [imgs]);
});
check('over cap → chunked preserving order', () => {
    const imgs = Array.from({ length: 10 }, (_, i) => i);
    const chunks = chunkImages(imgs);
    assert.strictEqual(chunks.length, 2);
    assert.deepStrictEqual(chunks[0], [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepStrictEqual(chunks[1], [8, 9]);
});
check('custom chunk size honored', () => {
    const imgs = Array.from({ length: 5 }, (_, i) => i);
    const chunks = chunkImages(imgs, 2);
    assert.strictEqual(chunks.length, 3);
    assert.deepStrictEqual(chunks[0], [0, 1]);
    assert.deepStrictEqual(chunks[2], [4]);
});
check('chunk size clamped to >= 1', () => {
    const imgs = [1, 2];
    assert.deepStrictEqual(chunkImages(imgs, 0), [[1], [2]]);
});

// --- combineImageDescriptions ---
check('all empty → empty string', () => {
    assert.strictEqual(combineImageDescriptions(['', '   ']), '');
});
check('single description passes through unchanged', () => {
    assert.strictEqual(combineImageDescriptions(['hello']), 'hello');
});
check('multiple joined with group headers in order', () => {
    const out = combineImageDescriptions(['first', 'second', 'third']);
    assert.ok(out.includes('[Image group 1/3]'), out);
    assert.ok(out.includes('[Image group 2/3]'));
    assert.ok(out.includes('[Image group 3/3]'));
    const idx1 = out.indexOf('first');
    const idx2 = out.indexOf('second');
    const idx3 = out.indexOf('third');
    assert.ok(idx1 < idx2 && idx2 < idx3, 'order preserved');
});
check('empty chunks skipped, numbering re-based', () => {
    const out = combineImageDescriptions(['a', '', 'b']);
    assert.ok(out.includes('[Image group 1/2]'));
    assert.ok(out.includes('[Image group 2/2]'));
    assert.ok(!out.includes('3/'));
});

// --- structured prompt ---
const prompt = getStructuredImageVisionPrompt();
check('structured prompt mentions OCR', () => {
    assert.ok(/OCR/i.test(prompt));
});
check('structured prompt mentions tables as markdown', () => {
    assert.ok(/markdown table/i.test(prompt));
});
check('structured prompt mentions layout', () => {
    assert.ok(/layout/i.test(prompt));
});
check('structured prompt forbids invented content', () => {
    assert.ok(/Do NOT invent content/i.test(prompt));
});
check('structured prompt says unreadable regions', () => {
    assert.ok(/unreadable/i.test(prompt));
});
check('structured prompt keeps order for multiple images', () => {
    assert.ok(/preserving their order/i.test(prompt));
});

console.log(`\ntest-image-vision: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
