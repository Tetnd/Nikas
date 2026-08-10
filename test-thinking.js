// test-thinking.js — verifies the thinking-effort wiring mirrors src/provider.ts.
//
// Covers the full chain:
//   1. resolveEffort — nikas.thinkingEffort for the executor; invisible internal
//      helper requests (chat titles, commit messages, settings resolver, todo
//      tracker, categorize_prompt, ...) are ALWAYS forced to thinking off
//      (v0.7.31 lean routing, default-on).
//   2. buildThinkingParams       — chat-completions wire format
//   3. buildResponsesThinkingParams — Responses API wire format
//   4. boostedTokens             — max_tokens sent as-is (boost removed 2026-08-09)
//   5. CRITICAL: "off" must ALWAYS send the disabling param. DeepSeek V4
//      enables thinking BY DEFAULT when the param is absent — it silently
//      burns the whole output budget on reasoning and returns empty text
//      (proven 2026-08-09 via --diag: output_tokens=2000, reasoning_tokens=2000,
//      text=""). So an `off` request that OMITS the param is a real bug.
//
// Mirrors the post-audit provider.ts (all fixes applied).

// ── Mirrors of src/provider.ts ──
const VALID_EFFORTS = new Set(['off', 'low', 'high', 'max']);

function getThinkingEffortSafe(value) {
    return VALID_EFFORTS.has(value) ? value : 'off';
}

// v0.7.31 lean routing: invisible internal helpers always force thinking off;
// everything else (the executor / real agent) uses the configured setting.
const INTERNAL_HELPER_KINDS = new Set([
    'todo-tracker', 'prompt-categorizer', 'settings-resolver', 'chat-title',
    'inline-progress-message', 'git-branch-name', 'git-commit-message', 'rename-suggestions',
]);
function resolveEffort(requestKind, savedSetting) {
    return INTERNAL_HELPER_KINDS.has(requestKind) ? 'off' : getThinkingEffortSafe(savedSetting);
}

function buildThinkingParams(effort) {
    if (effort === 'off') {
        return { thinking: { type: 'disabled' } };
    }
    return {
        thinking: { type: 'enabled' },
        reasoning_effort: effort,
    };
}

function buildResponsesThinkingParams(effort) {
    if (effort === 'off') {
        return { reasoning: { effort: 'none' } };
    }
    return { reasoning: { effort } };
}

function boostedTokens(_thinkingEnabled, effectiveMaxTokens, _effort) {
    // NOTE (2026-08-09): the boost was REMOVED — the configured maxTokens is
    // sent as-is for every effort level, thinking on or off.
    return effectiveMaxTokens;
}

// ── Test harness ──
let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS ${name}`); }
    else { fail++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

console.log('=== 1. Effort resolution (executor vs internal helpers) ===');
// v0.7.31 lean routing: the executor (real agent) uses the configured setting;
// invisible internal helpers (chat titles, commit messages, categorize_prompt,
// settings resolver, todo tracker, ...) are ALWAYS forced to thinking off.
check('executor max → max', resolveEffort('main-agent', 'max') === 'max');
check('executor low → low', resolveEffort('unknown', 'low') === 'low');
check('executor high → high', resolveEffort('main-agent', 'high') === 'high');
check('chat-title helper → off (even at max)', resolveEffort('chat-title', 'max') === 'off');
check('commit-message helper → off (even at max)', resolveEffort('git-commit-message', 'max') === 'off');
check('categorize_prompt helper → off (even at max)', resolveEffort('prompt-categorizer', 'max') === 'off');
check('settings-resolver helper → off (even at max)', resolveEffort('settings-resolver', 'max') === 'off');
check('todo-tracker helper → off (even at max)', resolveEffort('todo-tracker', 'max') === 'off');
check('rename-suggestions helper → off (even at max)', resolveEffort('rename-suggestions', 'max') === 'off');
check('inline-progress helper → off (even at max)', resolveEffort('inline-progress-message', 'max') === 'off');
check('git-branch helper → off (even at max)', resolveEffort('git-branch-name', 'max') === 'off');
// Invalid saved value must not leak to the API (defaults to off, matching Nika)
check('invalid saved value → off (guarded)', resolveEffort('unknown', 'xhigh') === 'off');
check('invalid saved value → off (guarded 2)', resolveEffort('unknown', 'yes') === 'off');

console.log('\n=== 2. Chat params (buildThinkingParams) ===');
check('off → thinking disabled (param PRESENT — critical)', JSON.stringify(buildThinkingParams('off')) === '{"thinking":{"type":"disabled"}}');
check('low → enabled + low', JSON.stringify(buildThinkingParams('low')) === '{"thinking":{"type":"enabled"},"reasoning_effort":"low"}');
check('high → enabled + high', JSON.stringify(buildThinkingParams('high')) === '{"thinking":{"type":"enabled"},"reasoning_effort":"high"}');
check('max → enabled + max', JSON.stringify(buildThinkingParams('max')) === '{"thinking":{"type":"enabled"},"reasoning_effort":"max"}');

console.log('\n=== 3. Responses params (buildResponsesThinkingParams) ===');
check('off → reasoning none (param PRESENT — critical)', JSON.stringify(buildResponsesThinkingParams('off')) === '{"reasoning":{"effort":"none"}}');
check('low → reasoning low', JSON.stringify(buildResponsesThinkingParams('low')) === '{"reasoning":{"effort":"low"}}');
check('high → reasoning high', JSON.stringify(buildResponsesThinkingParams('high')) === '{"reasoning":{"effort":"high"}}');
check('max → reasoning max', JSON.stringify(buildResponsesThinkingParams('max')) === '{"reasoning":{"effort":"max"}}');

console.log('\n=== 4. max_tokens boost (boostedTokens) ===');
check('thinking off + 8K → 8K (no boost)', boostedTokens(false, 8192, 'off') === 8192);
check('thinking off + 4K → 4K (no boost)', boostedTokens(false, 4096, 'off') === 4096);
check('thinking on(low) + 8K → 8K (no boost)', boostedTokens(true, 8192, 'low') === 8192);
check('thinking on(high) + 4K → 4K (no boost)', boostedTokens(true, 4096, 'high') === 4096);
check('thinking on(max) + 8K → 8K (no boost)', boostedTokens(true, 8192, 'max') === 8192);
check('thinking on(max) + 16K → 16K (no boost)', boostedTokens(true, 16384, 'max') === 16384);
check('thinking on(max) + 64K → 64K (unchanged)', boostedTokens(true, 65536, 'max') === 65536);
check('thinking on(high) + 32K → 32K (unchanged)', boostedTokens(true, 32768, 'high') === 32768);
check('thinking on + 128K → 128K (unchanged)', boostedTokens(true, 131072, 'high') === 131072);

console.log('\n=== 5. End-to-end: effective request shape per effort ===');
function chatRequest(effort, baseMax) {
    return { max_tokens: boostedTokens(effort !== 'off', baseMax, effort), ...buildThinkingParams(effort) };
}
function responsesRequest(effort, baseMax) {
    return { max_output_tokens: boostedTokens(effort !== 'off', baseMax, effort), ...buildResponsesThinkingParams(effort) };
}
// off must include the disabling param and NOT boost
check('chat off request', JSON.stringify(chatRequest('off', 8192)) === '{"max_tokens":8192,"thinking":{"type":"disabled"}}');
check('responses off request', JSON.stringify(responsesRequest('off', 8192)) === '{"max_output_tokens":8192,"reasoning":{"effort":"none"}}');
// thinking must enable but NOT boost
const ch = chatRequest('high', 8192);
check('chat high request enables without boost', ch.max_tokens === 8192 && ch.thinking.type === 'enabled' && ch.reasoning_effort === 'high');
const rr = responsesRequest('max', 8192);
check('responses max request enables without boost', rr.max_output_tokens === 8192 && rr.reasoning.effort === 'max');

console.log('');
console.log(`===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
