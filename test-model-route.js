// test-model-route.js — tests for the v0.7.84 DeepSeek model router.
// Pure module: requires ../out/modelRoute.js (no vscode dependency).
const assert = require('assert');
const {
    decideDeepSeekRoute,
    isInternalHelperKind,
    DEEPSEEK_CHAT_MODELS,
    ROUTE_CHEAP_CHAT_MODEL,
} = require('./out/modelRoute.js');

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

// --- disabled (default) ---
check('disabled → no route even for internal helper on Pro', () => {
    const r = decideDeepSeekRoute('git-commit-message', 'deepseek-v4-pro', false);
    assert.strictEqual(r.modelId, undefined);
});

// --- internal helpers route Pro → Flash when enabled ---
check('internal helper on Pro routes to Flash', () => {
    const r = decideDeepSeekRoute('chat-title', 'deepseek-v4-pro', true);
    assert.strictEqual(r.modelId, 'deepseek-v4-flash');
    assert.ok(r.reason && r.reason.startsWith('internal-helper'));
});

// --- already on Flash → no change ---
check('internal helper already on Flash → no route', () => {
    const r = decideDeepSeekRoute('git-commit-message', 'deepseek-v4-flash', true);
    assert.strictEqual(r.modelId, undefined);
});

// --- user-visible kinds never routed ---
const visible = ['main-agent', 'plan-agent', 'explore-agent', 'inline-agent', 'unknown'];
for (const kind of visible) {
    check(`visible kind ${kind} never routed on Pro`, () => {
        const r = decideDeepSeekRoute(kind, 'deepseek-v4-pro', true);
        assert.strictEqual(r.modelId, undefined);
    });
}

// --- Responses model never routed to /chat/completions ---
check('Responses model id is never routed', () => {
    const r = decideDeepSeekRoute('chat-title', 'deepseek-v4-flash-responses', true);
    assert.strictEqual(r.modelId, undefined);
});

// --- never cross-family / unknown model ---
check('unknown/foreign model id never routed', () => {
    const r = decideDeepSeekRoute('chat-title', 'some-other-model', true);
    assert.strictEqual(r.modelId, undefined);
});

// --- helper classification set ---
check('isInternalHelperKind true for git-commit-message', () => {
    assert.strictEqual(isInternalHelperKind('git-commit-message'), true);
});
check('isInternalHelperKind false for main-agent', () => {
    assert.strictEqual(isInternalHelperKind('main-agent'), false);
});

// --- constants sanity ---
check('ROUTE_CHEAP_CHAT_MODEL is in chat family', () => {
    assert.ok(DEEPSEEK_CHAT_MODELS.includes(ROUTE_CHEAP_CHAT_MODEL));
});
check('chat family has flash + pro', () => {
    assert.deepStrictEqual([...DEEPSEEK_CHAT_MODELS], ['deepseek-v4-flash', 'deepseek-v4-pro']);
});

// ── v0.7.85 auto mode ──────────────────────────────────────────────────────

// Heavy agent tasks on Flash → Pro (auto mode, with a real toolset).
check('auto: heavy main-agent on Flash upgrades to Pro', () => {
    const r = decideDeepSeekRoute('main-agent', 'deepseek-v4-flash', true, 'auto', 12);
    assert.strictEqual(r.modelId, 'deepseek-v4-pro');
    assert.ok(r.reason && r.reason.startsWith('heavy-task'));
});
check('auto: heavy plan-agent on Flash upgrades to Pro', () => {
    const r = decideDeepSeekRoute('plan-agent', 'deepseek-v4-flash', true, 'auto', 52);
    assert.strictEqual(r.modelId, 'deepseek-v4-pro');
});

// Heavy tasks below the tool threshold stay put.
check('auto: main-agent with few tools stays on Flash', () => {
    const r = decideDeepSeekRoute('main-agent', 'deepseek-v4-flash', true, 'auto', 3);
    assert.strictEqual(r.modelId, undefined);
});
check('auto: heavy main-agent already on Pro → no change', () => {
    const r = decideDeepSeekRoute('main-agent', 'deepseek-v4-pro', true, 'auto', 12);
    assert.strictEqual(r.modelId, undefined);
});

// Quick chats (inline/unknown, no tools) on Pro → Flash.
check('auto: quick inline chat on Pro downgrades to Flash', () => {
    const r = decideDeepSeekRoute('inline-agent', 'deepseek-v4-pro', true, 'auto', 0);
    assert.strictEqual(r.modelId, 'deepseek-v4-flash');
    assert.ok(r.reason && r.reason.startsWith('quick-chat'));
});
check('auto: unknown no-tools on Pro downgrades to Flash', () => {
    const r = decideDeepSeekRoute('unknown', 'deepseek-v4-pro', true, 'auto', 0);
    assert.strictEqual(r.modelId, 'deepseek-v4-flash');
});
check('auto: inline with tools stays on Pro', () => {
    const r = decideDeepSeekRoute('inline-agent', 'deepseek-v4-pro', true, 'auto', 4);
    assert.strictEqual(r.modelId, undefined);
});

// Internal helpers still route to Flash in auto mode.
check('auto: internal helper on Pro routes to Flash', () => {
    const r = decideDeepSeekRoute('chat-title', 'deepseek-v4-pro', true, 'auto', 0);
    assert.strictEqual(r.modelId, 'deepseek-v4-flash');
});

// Helpers-only mode (default) never upgrades heavy tasks.
check('helpers-only: heavy task never upgraded', () => {
    const r = decideDeepSeekRoute('main-agent', 'deepseek-v4-flash', true, 'helpers-only', 52);
    assert.strictEqual(r.modelId, undefined);
});
check('helpers-only: quick chat never downgraded', () => {
    const r = decideDeepSeekRoute('inline-agent', 'deepseek-v4-pro', true, 'helpers-only', 0);
    assert.strictEqual(r.modelId, undefined);
});

// Auto mode still never routes the Responses model.
check('auto: Responses model never routed', () => {
    const r = decideDeepSeekRoute('main-agent', 'deepseek-v4-flash-responses', true, 'auto', 52);
    assert.strictEqual(r.modelId, undefined);
});
check('auto: disabled → no route', () => {
    const r = decideDeepSeekRoute('main-agent', 'deepseek-v4-flash', false, 'auto', 52);
    assert.strictEqual(r.modelId, undefined);
});

console.log(`\ntest-model-route: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
