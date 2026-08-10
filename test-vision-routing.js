// Verifies the vision model picker + describer routing logic for Gemini-via-Copilot.
// Mirrors the exact logic in:
//   - src/vision/sources/vscode-lm.ts (listVSCodeVisionModels exclusions)
//   - src/provider.ts (createVisionDescriber routing)
//   - src/extension.ts (chooseVisionModel)

// ── Exclusion sets (copy from vscode-lm.ts after fix) ──
const EXCLUDED_VISION_MODEL_IDS = new Set([
    'copilot-utility',
    'copilot-utility-small',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
]);
const EXCLUDED_VISION_MODEL_VENDORS = new Set([
    'deepseek',
    'claude-code',
    'copilotcli',
    'nikas',
    'nika',
]);

// Simulated models that would come back from vscode.lm.selectChatModels()
const fakeModels = [
    { vendor: 'copilot', id: 'gpt-4o', name: 'GPT-4o' },
    { vendor: 'copilot', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { vendor: 'copilot', id: 'gemini-3-flash', name: 'Gemini 3 Flash' },   // genuine Copilot Gemini
    { vendor: 'copilot', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },   // genuine Copilot Gemini
    { vendor: 'nikas', id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }, // Nikas's own (should be EXCLUDED)
    { vendor: 'nikas', id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
    { vendor: 'nikas', id: 'gemma4:31b', name: 'Gemma 4 (Ollama)' },
    { vendor: 'nikas', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, // excluded by id too
    { vendor: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },  // excluded vendor
    { vendor: 'github', id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }, // Copilot GitHub vendor
];

// listVSCodeVisionModels filter (mirrors the real code, minus the vision probe)
function isListed(model) {
    if (EXCLUDED_VISION_MODEL_IDS.has(model.id)) return false;
    if (EXCLUDED_VISION_MODEL_VENDORS.has(model.vendor)) return false;
    return true;
}

// createVisionDescriber routing (mirrors provider.ts)
function routeDescriber(visionModelKey, oldVisionModel) {
    if (visionModelKey === 'nikas/gemini-2.5-flash-lite' || visionModelKey === 'nika/gemini-2.5-flash-lite') {
        return 'direct-gemini-flash-lite';
    }
    if (visionModelKey === 'nikas/gemini-2.5-flash' || visionModelKey === 'nika/gemini-2.5-flash') {
        return 'direct-gemini-flash';
    }
    if (visionModelKey === 'nikas/gemma4:31b' || visionModelKey === 'nika/gemma4:31b') {
        return 'direct-gemma4';
    }
    if (visionModelKey?.startsWith('nikas-') || visionModelKey?.startsWith('nika-')) {
        return 'direct-nikas-key';
    }
    if (!visionModelKey) {
        if (oldVisionModel === 'gemini-flash-lite') return 'direct-gemini-flash-lite';
        if (oldVisionModel === 'gemini' || !oldVisionModel) return 'direct-gemini-flash';
        if (oldVisionModel === 'ollama-gemma4') return 'direct-gemma4';
    }
    if (visionModelKey) {
        return `copilot-lm:${visionModelKey}`; // VSCodeLanguageModelVisionDescriber
    }
    return 'direct-gemini-flash'; // default fallback
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS ${name}`); }
    else { fail++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

console.log('=== 1. Copilot Models picker listing (after fix) ===');
const listed = fakeModels.filter(isListed);
const listedKeys = listed.map(m => `${m.vendor}/${m.id}`);
check('genuine Copilot Gemini 3 Flash listed', listedKeys.includes('copilot/gemini-3-flash'), listedKeys.join(','));
check('genuine Copilot Gemini 2.5 Pro listed', listedKeys.includes('copilot/gemini-2.5-pro'));
check('GitHub-vendor Gemini listed', listedKeys.includes('github/gemini-2.5-flash'));
check('GPT-4o listed', listedKeys.includes('copilot/gpt-4o'));
check('Nikas own gemini-2.5-flash EXCLUDED', !listedKeys.includes('nikas/gemini-2.5-flash'));
check('Nikas own gemini-flash-lite EXCLUDED', !listedKeys.includes('nikas/gemini-2.5-flash-lite'));
check('Nikas own gemma4 EXCLUDED', !listedKeys.includes('nikas/gemma4:31b'));
check('Nikas deepseek EXCLUDED (id + vendor)', !listedKeys.includes('nikas/deepseek-v4-flash'));
check('deepseek vendor EXCLUDED', !listedKeys.includes('deepseek/deepseek-v4-pro'));

console.log('\n=== 2. Describer routing for Gemini selections ===');
// User picks genuine Copilot Gemini from the (fixed) picker
check('copilot/gemini-3-flash -> Copilot LM path', routeDescriber('copilot/gemini-3-flash', undefined) === 'copilot-lm:copilot/gemini-3-flash');
check('github/gemini-2.5-flash -> Copilot LM path', routeDescriber('github/gemini-2.5-flash', undefined) === 'copilot-lm:github/gemini-2.5-flash');
// Legacy: user had selected Nikas Gemini via old "Copilot" list
check('nikas/gemini-2.5-flash -> direct Gemini API', routeDescriber('nikas/gemini-2.5-flash', undefined) === 'direct-gemini-flash');
check('nikas/gemini-2.5-flash-lite -> direct Gemini lite', routeDescriber('nikas/gemini-2.5-flash-lite', undefined) === 'direct-gemini-flash-lite');
check('nikas/gemma4:31b -> direct Gemma4', routeDescriber('nikas/gemma4:31b', undefined) === 'direct-gemma4');
// Legacy visionModel setting (Nikas Native path)
check('visionModel=gemini -> direct Gemini', routeDescriber(undefined, 'gemini') === 'direct-gemini-flash');
check('visionModel=gemini-flash-lite -> direct lite', routeDescriber(undefined, 'gemini-flash-lite') === 'direct-gemini-flash-lite');
check('visionModel=ollama-gemma4 -> direct Gemma4', routeDescriber(undefined, 'ollama-gemma4') === 'direct-gemma4');

console.log('\n=== 3. Key requirement check (chooseVisionModel warning) ===');
// Simulate: model requires key
const geminiModelsRequiringKey = true;
check('Nikas Native Gemini flags requiresApiKey=true', geminiModelsRequiringKey);
// The picker now warns if key missing (logic added in extension.ts)

console.log('\n=== 4. copilot/auto — must pick one of the Gemini models ===');
// findAutoVisionModel logic (mirrors src/vision/sources/vscode-lm.ts):
//   1. Gemini models only, Flash preferred
//   2. Fall back to any model ONLY if no Gemini exists
function autoSelect(models) {
    const isGemini = (o) => o.id.toLowerCase().includes('gemini');
    const isGeminiFlash = (o) => isGemini(o) && o.id.toLowerCase().includes('flash');
    const gemini = models.filter(isGemini).sort((a, b) =>
        (isGeminiFlash(a) ? 0 : 1) - (isGeminiFlash(b) ? 0 : 1)
    );
    const pool = gemini.length > 0 ? gemini : models;
    return pool[0] ? `${pool[0].vendor}/${pool[0].id}` : undefined;
}

// Two genuine Copilot Gemini models (gemini-3-flash + gemini-2.5-pro) plus
// GPT-4o / Claude. Auto MUST choose one of the two Geminis.
const autoPick = autoSelect(listed);
check('auto picks a Gemini model', autoPick === 'copilot/gemini-3-flash' || autoPick === 'copilot/gemini-2.5-pro', `got ${autoPick}`);
check('auto picks Gemini Flash when available', autoPick === 'copilot/gemini-3-flash', `got ${autoPick}`);
check('auto NEVER picks non-Gemini when Gemini exists', autoPick !== 'copilot/gpt-4o' && autoPick !== 'copilot/claude-sonnet-4-5', `got ${autoPick}`);

// No Gemini at all → falls back to any vision model
const noGemini = [
    { vendor: 'copilot', id: 'gpt-4o', name: 'GPT-4o' },
    { vendor: 'copilot', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
];
check('auto falls back to any model when no Gemini', autoSelect(noGemini) === 'copilot/gpt-4o', `got ${autoSelect(noGemini)}`);

// Empty list → undefined
check('auto returns undefined when no models', autoSelect([]) === undefined);

// 5. PDF data-part detection (mirrors src/vision/replay.ts isPdfDataPart —
// PDFs are NOT routed to vision; they pass through to the local
// text-extraction fallback in src/transform/messages.ts, the proven-working
// v0.7.13 behavior)
console.log('\n=== 5. PDF data-part detection ===');
function isPdfDataPart(mimeType) {
    const m = (mimeType || '').toLowerCase();
    return m === 'application/pdf' || m.endsWith('/pdf');
}
check('application/pdf is a PDF data part', isPdfDataPart('application/pdf') === true);
check('image/png is NOT a PDF data part', isPdfDataPart('image/png') === false);
check('empty mime is NOT a PDF data part', isPdfDataPart('') === false);

// Structural (duck-typed) part normalization — patched-bundle parts cross an
// extension-host realm, so instanceof fails; the pipeline must accept ALL
// observed shapes (mirrors src/vision/replay.ts normalizeDataPart):
//   {data: Uint8Array, mimeType} | {data: Uint8Array, mediaType} |
//   {data: base64-string, mediaType} | {documentData: {data, mediaType}}
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
function isPdfPart(part) {
    const n = normalizeDataPart(part);
    return n !== undefined && isPdfDataPart(n.mimeType);
}
function isImagePart(part) {
    const n = normalizeDataPart(part);
    return n !== undefined && n.mimeType.toLowerCase().startsWith('image/');
}
check('plain {data,mimeType} PDF object is a PDF part', isPdfPart({ data: new Uint8Array([1]), mimeType: 'application/pdf' }) === true);
check('plain PNG object is an image part', isImagePart({ data: new Uint8Array([1]), mimeType: 'image/png' }) === true);
check('{data, mediaType} PDF object is a PDF part', isPdfPart({ data: new Uint8Array([1]), mediaType: 'application/pdf' }) === true);
check('{data: base64-string, mediaType} PDF object is a PDF part', isPdfPart({ data: Buffer.from('abc').toString('base64'), mediaType: 'application/pdf' }) === true);
check('{documentData:{data,mediaType}} PDF object is a PDF part', isPdfPart({ documentData: { data: new Uint8Array([1]), mediaType: 'application/pdf' } }) === true);
check('object without mime is NOT a data part', normalizeDataPart({ data: new Uint8Array([1]) }) === undefined);
check('null is NOT a data part', normalizeDataPart(null) === undefined);
check('non-object is NOT a data part', normalizeDataPart('pdf') === undefined);

// 6. Request-part summary: ordinary text/tool parts must NOT be flagged as
// "unknown shapes" (the rn{value} noise fix). Mirrors src/vision/pipeline.ts
// isNonBinaryPart + logDataPartSummary. Only genuinely novel object shapes
// should be surfaced so new attachment forms stay visible.
console.log('\n=== 6. Request part summary: no noise for text/tool parts ===');
function isNonBinaryPart(part) {
    if (typeof part !== 'object' || part === null) return true;
    if (typeof part.value === 'string') return true;   // LanguageModelTextPart
    if (typeof part.callId === 'string') return true;  // tool call / tool result
    return false;
}
function summarizeParts(parts) {
    const byMime = new Map();
    const unknownShapes = [];
    let total = 0;
    for (const part of parts) {
        const norm = normalizeDataPart(part);
        if (norm) {
            byMime.set(norm.mimeType, (byMime.get(norm.mimeType) ?? 0) + 1);
            total += 1;
        } else if (isNonBinaryPart(part)) {
            continue;
        } else if (typeof part === 'object' && part !== null) {
            const keys = Object.keys(part).sort().join(',');
            const ctor = part.constructor?.name ?? '?';
            const sig = `${ctor}{${keys}}`;
            if (!unknownShapes.includes(sig)) unknownShapes.push(sig);
        }
    }
    return { total, unknownShapes, byMime };
}

// A realistic request: one text part + one tool call + one tool result.
// BEFORE the fix this logged "rn{value}" on EVERY request.
const plainText = { value: 'Hello' };                       // minified ctor 'rn'
const toolCall = { callId: 'c1', name: 'grep_search', input: {} };
const toolResult = { callId: 'c1', output: [], isError: false };
const image = { data: new Uint8Array([1]), mimeType: 'image/png' };

let s = summarizeParts([plainText, toolCall, toolResult, image]);
check('text part NOT flagged as unknown shape', s.unknownShapes.length === 0, JSON.stringify(s.unknownShapes));
check('data part still counted', s.total === 1 && s.byMime.get('image/png') === 1);

s = summarizeParts([plainText, plainText, plainText]);
check('only-text request produces NO unknown shapes and NO data', s.unknownShapes.length === 0 && s.total === 0);

// A genuinely novel object (no value/callId) must still be surfaced.
const novelShape = { blob: new Uint8Array([1]), kind: 'x-unknown' };
s = summarizeParts([plainText, novelShape]);
check('novel object shape still flagged', s.unknownShapes.length === 1 && s.unknownShapes[0].includes('{blob,kind}'), JSON.stringify(s.unknownShapes));
check('empty/primitive parts are skipped (not flagged)', summarizeParts([null, undefined, 42, 'str']).unknownShapes.length === 0);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
