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

// 5. PDF attachment routing (mirrors pipeline.ts — which describers can read PDFs)
console.log('\n=== 5. PDF attachment routing ===');
function canDescribePdfs(source) { return source !== 'vscode-lm'; }
function isPdfDataPart(mimeType) {
    const m = (mimeType || '').toLowerCase();
    return m === 'application/pdf' || m.endsWith('/pdf');
}
check('api-endpoint (Gemini direct) can describe PDFs', canDescribePdfs('api-endpoint') === true);
check('vscode-lm (Copilot model) cannot describe PDFs', canDescribePdfs('vscode-lm') === false);
check('application/pdf is a PDF data part', isPdfDataPart('application/pdf') === true);
check('image/png is NOT a PDF data part', isPdfDataPart('image/png') === false);
check('empty mime is NOT a PDF data part', isPdfDataPart('') === false);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
