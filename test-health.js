// test-health.js — mirrors src/commands/healthReport.ts (v0.7.86). Pure module.
const assert = require('assert');
const {
    buildHealthReport,
    formatCacheRate,
} = require('./out/commands/healthReport.js');

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

function baseInput() {
    return {
        version: '0.7.86',
        deepSeekKey: true,
        geminiKey: false,
        selectedModel: 'deepseek-v4-pro',
        routerEnabled: true,
        routerMode: 'auto',
        contextWindowTokens: 64000,
        maxTokens: 4096,
        thinkingEffort: 'high',
        toolBudget: true,
        toolBudgetTokens: 12000,
        pdfExtractCache: true,
        visionSource: 'gemini',
        visionModel: 'gemini-2.5-flash',
        usage: { requests: 10, totalTokens: 50000, estimatedCost: 0.0123, cacheHitTokens: 6000, cacheMissTokens: 4000 },
        patches: { found: true, applied: 4, missing: [], bundlePath: '/x/extension.js' },
        logPath: '/x/nikas.log',
        logSizeBytes: 2048,
    };
}

// --- formatCacheRate ---
check('cache rate 60%', () => {
    assert.strictEqual(formatCacheRate(6000, 4000), '60%');
});
check('cache rate all hit 100%', () => {
    assert.strictEqual(formatCacheRate(10, 0), '100%');
});
check('cache rate no data → em dash', () => {
    assert.strictEqual(formatCacheRate(undefined, undefined), '—');
});
check('cache rate zero total → em dash', () => {
    assert.strictEqual(formatCacheRate(0, 0), '—');
});

// --- report structure ---
const r = buildHealthReport(baseInput());
check('report has title with version', () => {
    assert.ok(r.includes('# Nikas Health Check — v0.7.86'));
});
check('report shows selected model', () => {
    assert.ok(r.includes('deepseek-v4-pro'));
});
check('report shows router state', () => {
    assert.ok(r.includes('Model router:** ON (auto)'));
});
check('report shows tool budget', () => {
    assert.ok(r.includes('Tool-description budget:** ON (12,000 tokens)'));
});
check('report shows pdf extract cache', () => {
    assert.ok(r.includes('PDF extraction cache:** ON'));
});
check('report shows deepseek key configured', () => {
    assert.ok(r.includes('DeepSeek API key:** ✅ configured'));
});
check('report shows cache hit rate', () => {
    assert.ok(r.includes('Prompt-cache hit rate:** 60%'));
});
check('report shows all patches applied', () => {
    assert.ok(r.includes('All 4 patches applied'));
});
check('report shows bundle path', () => {
    assert.ok(r.includes('/x/extension.js'));
});
check('report shows log size', () => {
    assert.ok(r.includes('2.0 KB'));
});
check('report is read-only note', () => {
    assert.ok(r.includes('read-only'));
});

// --- missing key ---
check('missing deepseek key flagged', () => {
    const input = baseInput();
    input.deepSeekKey = false;
    const out = buildHealthReport(input);
    assert.ok(out.includes('DeepSeek API key:** ❌ MISSING'));
});

// --- missing patches flagged ---
check('missing patches listed', () => {
    const input = baseInput();
    input.patches = { found: true, applied: 2, missing: ['patch-1', 'patch-2'], bundlePath: '/x/extension.js' };
    const out = buildHealthReport(input);
    assert.ok(out.includes('2 patch(es) MISSING: patch-1, patch-2'));
});
// --- bundle not found ---
check('bundle not found reported', () => {
    const input = baseInput();
    input.patches = { found: false, applied: 0, missing: [] };
    const out = buildHealthReport(input);
    assert.ok(out.includes('bundle **not found**'));
});

// --- no cache data → no cache line ---
check('no cache data omits cache line', () => {
    const input = baseInput();
    input.usage.cacheHitTokens = undefined;
    input.usage.cacheMissTokens = undefined;
    const out = buildHealthReport(input);
    assert.ok(!out.includes('Prompt-cache hit rate'));
});

console.log(`\ntest-health: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
