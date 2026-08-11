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
    return VALID_EFFORTS.has(value) ? value : 'low';
}

// v0.7.31/0.7.32 lean routing, gated behind nikas.helperThinkingOff:
// - applied (true): invisible internal helpers force thinking off; the
//   executor (real agent) uses the configured setting.
// - unapplied (false): Nika parity — every request (helpers included) uses
//   the configured setting.
const INTERNAL_HELPER_KINDS = new Set([
    'todo-tracker', 'prompt-categorizer', 'settings-resolver', 'chat-title',
    'inline-progress-message', 'git-branch-name', 'git-commit-message', 'rename-suggestions',
]);
function resolveEffort(requestKind, savedSetting, helperThinkingOff) {
    return (helperThinkingOff && INTERNAL_HELPER_KINDS.has(requestKind)) ? 'off' : getThinkingEffortSafe(savedSetting);
}

// v0.7.35: model-picker dropdown (restored to match upstream Nika) is read
// first via options.modelConfiguration.reasoningEffort; falls back to the
// saved setting. Mirrors getRequestThinkingEffort in provider.ts.
function resolveDropdownEffort(modelConfigEffort, savedSetting) {
    if (modelConfigEffort === 'none') return 'off';
    if (modelConfigEffort === 'low') return 'low';
    if (modelConfigEffort === 'high') return 'high';
    if (modelConfigEffort === 'max') return 'max';
    return getThinkingEffortSafe(savedSetting);
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

// v0.7.67: per-agent effort (nikas.agentEfforts). Mirrors src/routing.ts.
// - DEFAULT_AGENT_EFFORTS: plan→max, explore→low, inline→low, helper→low
//   (main absent → uses configured effort).
// - requestKindToAgentKind maps a RequestKind to its AgentKind.
// - resolveAgentEffort(requestKind, baseEffort): helper-off first (when
//   helperThinkingOff), then agent-effort override, then default.
const DEFAULT_AGENT_EFFORTS = { plan: 'max', explore: 'low', inline: 'low', helper: 'low' };
const AGENT_KIND_BY_REQUEST = {
    'todo-tracker': 'helper', 'prompt-categorizer': 'helper', 'settings-resolver': 'helper',
    'chat-title': 'helper', 'inline-progress-message': 'helper', 'git-branch-name': 'helper',
    'git-commit-message': 'helper', 'rename-suggestions': 'helper',
    'plan-agent': 'plan', 'explore-agent': 'explore', 'inline-agent': 'inline',
    'main-agent': 'main', 'unknown': 'main',
};
const INTERNAL_HELPER_KINDS_ARRAY = ['todo-tracker', 'prompt-categorizer', 'settings-resolver', 'chat-title',
    'inline-progress-message', 'git-branch-name', 'git-commit-message', 'rename-suggestions'];
function requestKindToAgentKind(kind) { return AGENT_KIND_BY_REQUEST[kind] ?? 'main'; }
function getAgentEffort(kind, configured) {
    const merged = { ...DEFAULT_AGENT_EFFORTS, ...(configured ?? {}) };
    return merged[kind];
}
function resolveAgentEffort(requestKind, baseEffort, helperThinkingOff, agentEfforts) {
    if (helperThinkingOff && INTERNAL_HELPER_KINDS_ARRAY.includes(requestKind)) {
        return { effort: 'off', source: 'helper-off' };
    }
    const override = getAgentEffort(requestKindToAgentKind(requestKind), agentEfforts);
    if (override) return { effort: override, source: 'agent-effort' };
    return { effort: baseEffort, source: 'default' };
}
// Mirrors classifyProviderRequest's inline heuristic.
const AGENT_HALLMARKS = ['open_browser_page', 'run_in_terminal', 'runInTerminal', 'browser', 'search', 'grep_search'];
function isLikelyInline(toolNames) {
    if (toolNames.length === 0) return true;
    const hasHallmark = AGENT_HALLMARKS.some(t => toolNames.includes(t));
    return !hasHallmark && toolNames.length <= 4;
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
// v0.7.32 lean routing gated behind nikas.helperThinkingOff. When applied
// (true): the executor uses the configured setting; invisible internal
// helpers (chat titles, commit messages, categorize_prompt, settings
// resolver, todo tracker, ...) are forced to thinking off. When unapplied
// (false): Nika parity — helpers run at the configured effort too.

// --- helperThinkingOff = true (applied) ---
check('executor max → max', resolveEffort('main-agent', 'max', true) === 'max');
check('executor low → low', resolveEffort('unknown', 'low', true) === 'low');
check('executor high → high', resolveEffort('main-agent', 'high', true) === 'high');
check('chat-title helper → off (even at max)', resolveEffort('chat-title', 'max', true) === 'off');
check('commit-message helper → off (even at max)', resolveEffort('git-commit-message', 'max', true) === 'off');
check('categorize_prompt helper → off (even at max)', resolveEffort('prompt-categorizer', 'max', true) === 'off');
check('settings-resolver helper → off (even at max)', resolveEffort('settings-resolver', 'max', true) === 'off');
check('todo-tracker helper → off (even at max)', resolveEffort('todo-tracker', 'max', true) === 'off');
check('rename-suggestions helper → off (even at max)', resolveEffort('rename-suggestions', 'max', true) === 'off');
check('inline-progress helper → off (even at max)', resolveEffort('inline-progress-message', 'max', true) === 'off');
check('git-branch helper → off (even at max)', resolveEffort('git-branch-name', 'max', true) === 'off');

// --- helperThinkingOff = false (unapplied, Nika parity) ---
check('Nika parity: chat-title helper at max → max', resolveEffort('chat-title', 'max', false) === 'max');
check('Nika parity: commit-message helper at max → max', resolveEffort('git-commit-message', 'max', false) === 'max');
check('Nika parity: categorize_prompt helper at low → low', resolveEffort('prompt-categorizer', 'low', false) === 'low');
check('Nika parity: settings-resolver helper at off → off', resolveEffort('settings-resolver', 'off', false) === 'off');
check('Nika parity: todo-tracker helper at high → high', resolveEffort('todo-tracker', 'high', false) === 'high');
check('Nika parity: executor max → max', resolveEffort('main-agent', 'max', false) === 'max');

// Invalid saved value must not leak to the API (defaults to low)
check('invalid saved value → low (guarded)', resolveEffort('unknown', 'xhigh', true) === 'low');
check('invalid saved value → low (guarded 2)', resolveEffort('unknown', 'yes', true) === 'low');

console.log('\n=== 1b. Model-picker dropdown effort (v0.7.35, matches Nika) ===');
// Dropdown wins over the saved setting when it carries a value.
check('dropdown none → off', resolveDropdownEffort('none', 'low') === 'off');
check('dropdown low → low', resolveDropdownEffort('low', 'max') === 'low');
check('dropdown high → high', resolveDropdownEffort('high', 'off') === 'high');
check('dropdown max → max', resolveDropdownEffort('max', 'low') === 'max');
// No dropdown value → falls back to the saved setting.
check('no dropdown → saved setting low', resolveDropdownEffort(undefined, 'low') === 'low');
check('no dropdown → saved setting max', resolveDropdownEffort(undefined, 'max') === 'max');
// Invalid dropdown value never leaks.
check('invalid dropdown → saved setting', resolveDropdownEffort('turbo', 'low') === 'low');

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

console.log('\n=== 6. Per-agent effort (nikas.agentEfforts, v0.7.67) ===');
// Default map: plan→max, explore→low, inline→low, helper→low, main→(unset).
check('agent kind map: plan → plan', requestKindToAgentKind('plan-agent') === 'plan');
check('agent kind map: explore → explore', requestKindToAgentKind('explore-agent') === 'explore');
check('agent kind map: inline → inline', requestKindToAgentKind('inline-agent') === 'inline');
check('agent kind map: helper → helper', requestKindToAgentKind('chat-title') === 'helper');
check('agent kind map: main → main', requestKindToAgentKind('main-agent') === 'main');
check('agent kind map: unknown → main', requestKindToAgentKind('unknown') === 'main');

// With defaults + helperThinkingOff=false: Plan=max, Explore=low, Inline=low, helper=low.
check('plan default → max (agent-effort)', resolveAgentEffort('plan-agent', 'low', false, undefined).effort === 'max');
check('explore default → low (agent-effort)', resolveAgentEffort('explore-agent', 'max', false, undefined).effort === 'low');
check('inline default → low (agent-effort)', resolveAgentEffort('inline-agent', 'max', false, undefined).effort === 'low');
check('helper default → low (agent-effort)', resolveAgentEffort('chat-title', 'max', false, undefined).effort === 'low');
check('main default → configured low (no override)', resolveAgentEffort('main-agent', 'low', false, undefined).effort === 'low');
check('main default → configured max (no override)', resolveAgentEffort('main-agent', 'max', false, undefined).effort === 'max');

// User override: set plan→low explicitly.
check('user override plan→low', resolveAgentEffort('plan-agent', 'low', false, { plan: 'low' }).effort === 'low');
check('user override explore→off', resolveAgentEffort('explore-agent', 'low', false, { explore: 'off' }).effort === 'off');
check('user override main→max', resolveAgentEffort('main-agent', 'low', false, { main: 'max' }).effort === 'max');

// helperThinkingOff=true still wins for internal helpers (helper-off source).
check('helperThinkingOff on → helper off (helper-off source)',
    resolveAgentEffort('chat-title', 'max', true, undefined).source === 'helper-off'
    && resolveAgentEffort('chat-title', 'max', true, undefined).effort === 'off');
check('helperThinkingOff on → plan still max (not helper)',
    resolveAgentEffort('plan-agent', 'low', true, undefined).effort === 'max');

// Inline heuristic mirrors classifyProviderRequest.
check('inline: no tools → inline', isLikelyInline([]) === true);
check('inline: 2 edit tools, no hallmark → inline', isLikelyInline(['edit', 'read']) === true);
check('not inline: browser present → false', isLikelyInline(['edit', 'open_browser_page', 'search', 'runInTerminal', 'grep_search', 'read']) === false);
check('not inline: many tools, no hallmark → false (too many)', isLikelyInline(['a', 'b', 'c', 'd', 'e', 'f']) === false);

console.log('');
console.log(`===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
