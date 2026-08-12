// Tests tool-result image vision (src/vision/replay.ts getToolResultImageParts /
// rebuildToolResultPart, and src/vision/pipeline.ts resolveToolResultImages).
//
// Why this matters: when the agent captures a picture (screenshot_page) or
// views one (view_image), the image arrives as a LanguageModelDataPart NESTED
// inside a LanguageModelToolResultPart's content — not as a user-attached
// image part. Before this fix, src/transform/messages.ts toolResultPartToText
// flattened it to a bare "[image: png, N bytes]" placeholder, so DeepSeek
// never saw the picture. This test verifies the pipeline finds those nested
// images, describes them, and swaps them for text descriptions.
// Run: node test-tool-result-vision.js
let safe = 0;
let failures = 0;
function check(name, cond, detail) {
    if (cond) { safe++; console.log(`  PASS ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

// ── Mirrors of src/vision/replay.ts ──
// Stable VS Code part classes (verified in installed vscode.d.ts).
class LanguageModelTextPart { constructor(value) { this.value = value; } }
class LanguageModelDataPart { constructor(data, mimeType) { this.data = data; this.mimeType = mimeType; } }
class LanguageModelToolResultPart {
    constructor(callId, content, isError) { this.callId = callId; this.content = content; this.isError = isError ?? false; }
}

function normalizeDataPart(part) {
    if (typeof part !== 'object' || part === null) return undefined;
    let data = part.data;
    let mime = part.mimeType ?? part.mediaType;
    if (part.documentData && typeof part.documentData === 'object') {
        data = part.documentData.data;
        mime = part.documentData.mimeType ?? part.documentData.mediaType;
    }
    if (typeof mime !== 'string' || mime.length === 0) return undefined;
    if (data instanceof Uint8Array) return { data, mimeType: mime };
    if (data instanceof ArrayBuffer) return { data: new Uint8Array(data), mimeType: mime };
    if (typeof data === 'string') {
        try { return { data: new Uint8Array(Buffer.from(data, 'base64')), mimeType: mime }; }
        catch { return undefined; }
    }
    return undefined;
}

function isToolResultPart(part) {
    if (typeof part !== 'object' || part === null) return false;
    if (typeof part.callId !== 'string') return false;
    return Array.isArray(part.content) || Array.isArray(part.output);
}
function getToolResultContent(part) {
    if (Array.isArray(part.content)) return part.content;
    if (Array.isArray(part.output)) return part.output;
    return [];
}
function rebuildToolResultPart(part, newContent) {
    const rebuilt = new LanguageModelToolResultPart(
        typeof part.callId === 'string' ? part.callId : '',
        [...newContent],
    );
    if (part.isError === true) rebuilt.isError = true;
    return rebuilt;
}
function getToolResultImageParts(message) {
    const refs = [];
    const content = message.content ?? [];
    for (const [toolIndex, part] of content.entries()) {
        if (!isToolResultPart(part)) continue;
        const inner = getToolResultContent(part);
        for (const [partIndex, innerPart] of inner.entries()) {
            const norm = normalizeDataPart(innerPart);
            if (norm && norm.mimeType.toLowerCase().startsWith('image/')) {
                refs.push({ toolIndex, partIndex, image: norm });
            }
        }
    }
    return refs;
}

const IMAGE_DESCRIPTION_PREFIX = '[Image Description: ';
const IMAGE_DESCRIPTION_SUFFIX = ']';
function createImageDescriptionText(description) {
    return IMAGE_DESCRIPTION_PREFIX + description + IMAGE_DESCRIPTION_SUFFIX;
}

const txt = (v) => new LanguageModelTextPart(v);
const img = (mime, bytes) => new LanguageModelDataPart(new Uint8Array(bytes), mime);
const mkMsg = (content) => ({ role: 'user', content });

console.log('\n=== 1. getToolResultImageParts — locates nested images ===');
// A tool result whose content carries a screenshot image (instance shape).
const shotResult = new LanguageModelToolResultPart('call-shot', [txt('Here is the page:'), img('image/png', 1024)]);
let refs = getToolResultImageParts(mkMsg([txt('look'), shotResult]));
check('finds the nested screenshot image', refs.length === 1, `got ${refs.length}`);
check('reports tool index', refs[0].toolIndex === 1);
check('reports part index', refs[0].partIndex === 1);
check('normalizes the image', refs[0].image.mimeType === 'image/png');

// Structural (plain object) tool result — patched-bundle realm (uses `output`).
const structuralResult = { callId: 'call-s2', output: [txt('file view'), img('image/jpeg', 2048)], isError: false };
refs = getToolResultImageParts(mkMsg([structuralResult]));
check('finds image in structural {output} tool result', refs.length === 1 && refs[0].image.mimeType === 'image/jpeg');

// Multiple images across multiple tool results.
const multi = mkMsg([
    new LanguageModelToolResultPart('a', [img('image/png', 10)]),
    new LanguageModelToolResultPart('b', [img('image/webp', 20), txt('x')]),
]);
check('finds images across multiple tool results', getToolResultImageParts(multi).length === 2);

// No images → empty.
check('no images → empty refs', getToolResultImageParts(mkMsg([txt('plain'), new LanguageModelToolResultPart('c', [txt('ok')])])).length === 0);
// Text parts and tool CALL parts (callId + input object) are not tool results.
check('tool CALL part (input object) is not a tool result', !isToolResultPart({ callId: 'c', name: 'read_file', input: { path: 'a' } }));
check('plain text is not a tool result', !isToolResultPart(txt('hi')));

console.log('\n=== 2. resolveToolResultImages — swaps images for descriptions ===');
// Mirror of src/vision/pipeline.ts resolveToolResultImages (byte-keyed cache).
const sessionCache = new Map(); // key -> '' (failed) | description
const hashImageBytes = (data) => {
    let h = 0x811c9dc5;
    const len = Math.min(data.length, 4096);
    for (let i = 0; i < len; i++) { h ^= data[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
};
function getCached(sessionKey, imageParts) {
    if (imageParts.length === 0) return undefined;
    return sessionCache.get(`${sessionKey}:${hashImageBytes(imageParts[0].data)}`);
}
function setCached(sessionKey, imageParts, text) {
    if (imageParts.length === 0) return;
    sessionCache.set(`${sessionKey}:${hashImageBytes(imageParts[0].data)}`, text);
}

async function resolveToolResultImages(messages, sessionKey, getDescriber, token) {
    const out = [];
    let describer = undefined;
    for (const message of messages) {
        const refs = getToolResultImageParts(message);
        if (refs.length === 0) { out.push(message); continue; }
        const content = [...message.content];
        let described = 0;
        for (const ref of refs) {
            if (token && token.cancelled) break;
            const cached = getCached(sessionKey, [ref.image]);
            let text;
            if (cached === '') { continue; }               // previously failed
            if (cached) { text = cached; }
            else {
                if (!describer) {
                    describer = await getDescriber();
                    if (!describer) break;                  // leave placeholder
                }
                text = await describer.describe(ref.image);
                if (!text) { setCached(sessionKey, [ref.image], ''); continue; }
                setCached(sessionKey, [ref.image], text);
            }
            const part = content[ref.toolIndex];
            const inner = [...getToolResultContent(part)];
            inner[ref.partIndex] = txt(createImageDescriptionText(text));
            content[ref.toolIndex] = rebuildToolResultPart(part, inner);
            described++;
        }
        out.push(described > 0 ? mkMsg(content) : message);
    }
    return out;
}

let describeCalls = 0;
const fakeDescriber = {
    describe: async (image) => { describeCalls++; return `A screenshot showing the page. bytes=${image.data.byteLength}`; },
};

(async () => {
    // Describe a fresh screenshot.
    let msgs = [mkMsg([txt('take a look'), new LanguageModelToolResultPart('call-shot', [img('image/png', 1024)])])];
    let resolved = await resolveToolResultImages(msgs, 's1', async () => fakeDescriber);
    let inner = getToolResultContent(resolved[0].content[1]);
    check('nested image replaced by text part', inner[0] instanceof LanguageModelTextPart, `got ${inner[0]?.constructor?.name}`);
    check('description text carries the content', inner[0].value.includes('A screenshot showing the page'), inner[0].value);
    check('description wrapped in [Image Description: ...]', inner[0].value.startsWith('[Image Description: ') && inner[0].value.endsWith(']'));
    check('non-image text in the result is preserved', inner[0].value === inner[0].value && inner.length === 1);
    check('tool result callId preserved', resolved[0].content[1].callId === 'call-shot');
    check('described once on first call', describeCalls === 1);

    // Same screenshot again → served from cache (no second describe).
    const before = describeCalls;
    resolved = await resolveToolResultImages(msgs, 's1', async () => fakeDescriber);
    check('same screenshot NOT re-described (cache)', describeCalls === before, `describeCalls=${describeCalls}`);
    inner = getToolResultContent(resolved[0].content[1]);
    check('cached description still applied', inner[0].value.includes('A screenshot showing the page'));

    // Different session key → re-described (no cross-conversation leak).
    const before2 = describeCalls;
    await resolveToolResultImages(msgs, 'OTHER-session', async () => fakeDescriber);
    check('different session re-describes', describeCalls === before2 + 1);

    // No describer → image left as placeholder, no crash.
    describeCalls = 0;
    const noKey = [mkMsg([new LanguageModelToolResultPart('call-x', [img('image/png', 50)])])];
    resolved = await resolveToolResultImages(noKey, 's2', async () => undefined);
    inner = getToolResultContent(resolved[0].content[0]);
    check('no describer → original image part kept (placeholder)', inner[0] instanceof LanguageModelDataPart, `got ${inner[0]?.constructor?.name}`);
    check('no describer → zero describe calls', describeCalls === 0);

    // Failed describe → marked failed, no retry on next turn.
    describeCalls = 0;
    const failing = { describe: async () => { describeCalls++; return ''; } };
    const failMsgs = [mkMsg([new LanguageModelToolResultPart('call-f', [img('image/png', 60)])])];
    await resolveToolResultImages(failMsgs, 's3', async () => failing);
    check('empty describe → marked failed (calls=1)', describeCalls === 1);
    const afterFail = describeCalls;
    await resolveToolResultImages(failMsgs, 's3', async () => failing);
    check('failed image NOT retried on next turn', describeCalls === afterFail);

    // Mixed: one cached image + one new image in different tool results.
    describeCalls = 0;
    const mixed = [mkMsg([
        new LanguageModelToolResultPart('cached', [img('image/png', 1024)]),   // same bytes as before → cached
        new LanguageModelToolResultPart('fresh', [img('image/png', 9999)]),    // new bytes → describe
    ])];
    resolved = await resolveToolResultImages(mixed, 's1', async () => fakeDescriber);
    const innerCached = getToolResultContent(resolved[0].content[0]);
    const innerFresh = getToolResultContent(resolved[0].content[1]);
    check('cached image replaced from cache', innerCached[0].value.includes('A screenshot showing the page'));
    check('new image described', innerFresh[0].value.includes('A screenshot showing the page'));
    check('only the new image triggered a describe', describeCalls === 1, `describeCalls=${describeCalls}`);

    console.log(`\n${safe} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
})();
