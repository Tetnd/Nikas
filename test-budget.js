// test-budget.js — unit tests for the context-budget manager (src/context/budget.ts),
// v0.7.81. The module is vscode-free by design, so we test the compiled output
// directly with plain node.
//
// Covers: getBudgetStatus level classification, isLowValueToolResult heuristics,
// and dropLowValueToolOutput (removes low-value tool results + their callers,
// preserves user turns, protects the newest messages, stops at target, never throws).

const {
    getBudgetStatus,
    isLowValueToolResult,
    dropLowValueToolOutput,
    WARN_THRESHOLD,
    CRITICAL_THRESHOLD,
} = require('./out/context/budget.js');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
    if (cond) { passed++; }
    else { failed++; failures.push(name); console.error('  FAIL: ' + name); }
}

// ── 1. getBudgetStatus level classification ──
{
    assert(getBudgetStatus(100, 1000).level === 'normal', '10% → normal');
    assert(getBudgetStatus(0, 1000).level === 'normal', '0% → normal');
    assert(getBudgetStatus(WARN_THRESHOLD, 100).level === 'warn', 'exact warn → warn');
    assert(getBudgetStatus(75, 100).level === 'warn', '75% → warn');
    assert(getBudgetStatus(CRITICAL_THRESHOLD, 100).level === 'critical', 'exact critical → critical');
    assert(getBudgetStatus(99, 100).level === 'critical', '99% → critical');
    assert(getBudgetStatus(50, 0).level === 'critical', 'available 0 → critical (avoid div by zero)');
    const s = getBudgetStatus(50, 200);
    assert(s.fillPercent === 25 && s.estimated === 50 && s.available === 200, 'fillPercent/estimated/available fields');
}

// ── 2. isLowValueToolResult heuristics ──
{
    assert(isLowValueToolResult(''), 'empty → low value');
    assert(isLowValueToolResult('   '), 'whitespace → low value');
    assert(isLowValueToolResult('[]'), '[] → low value');
    assert(isLowValueToolResult('{}'), '{} → low value');
    assert(isLowValueToolResult('none'), 'none → low value');
    assert(isLowValueToolResult('No matches found'), 'no matches found → low value');
    assert(isLowValueToolResult('No results'), 'no results → low value');
    assert(isLowValueToolResult('No files matched the pattern'), 'no files → low value');
    assert(isLowValueToolResult('n/a'), 'n/a → low value');
    assert(isLowValueToolResult('null'), 'null → low value');
    assert(!isLowValueToolResult('src/config.ts: line 42 — added getContextBudget()'), 'real content → NOT low value');
    assert(!isLowValueToolResult('function foo() { return 1; }'), 'code → NOT low value');
    assert(!isLowValueToolResult('3 matches found in src/provider.ts'), 'matches found → NOT low value');
    assert(!isLowValueToolResult('hello world this is meaningful output'), 'meaningful → NOT low value');
    assert(isLowValueToolResult(undefined) === true, 'undefined content → empty → low value (does not throw)');
}

// ── 3. dropLowValueToolOutput basic ──
{
    // Longer conversation so the low-value tool result falls outside protectNewest.
    const msgs = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'setup step' },
        { role: 'assistant', content: 'ok, setup done' },
        { role: 'user', content: 'now find the bug' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call1', function: { name: 'grep_search' } }] },
        { role: 'tool', tool_call_id: 'call1', content: 'No matches found' },
        { role: 'user', content: 'hmm, try again with different terms' },
        { role: 'assistant', content: 'trying', tool_calls: [{ id: 'call2', function: { name: 'grep_search' } }] },
        { role: 'tool', tool_call_id: 'call2', content: 'No matches found' },
        { role: 'user', content: 'second question, keep me' },
    ];
    const r = dropLowValueToolOutput(msgs, { protectNewest: 1 });
    assert(r.dropped === 2, 'dropped 2 low-value tool results (got ' + r.dropped + ')');
    assert(!r.messages.some(m => m.role === 'tool'), 'all low-value tool results removed');
    assert(!r.messages.some(m => m.role === 'assistant' && m.tool_calls), 'tool_calls callers removed');
    assert(r.messages.some(m => m.role === 'user' && m.content.includes('second question')), 'newest user preserved');
    assert(r.messages.some(m => m.role === 'user' && m.content.includes('setup step')), 'older user turn also preserved');
    assert(r.droppedPreviews.length === 2, 'droppedPreviews recorded');
}

// ── 4. protectNewest — does not touch the newest messages ──
{
    // All low-value tool results, but they're within protectNewest (newest) → not dropped.
    const msgs = [
        { role: 'user', content: 'q' },
        { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'grep' } }] },
        { role: 'tool', tool_call_id: 'c', content: 'No matches found' },
    ];
    // protectNewest default 4 → all 3 messages are within the protected tail → nothing dropped.
    const r = dropLowValueToolOutput(msgs);
    assert(r.dropped === 0, 'protectNewest keeps newest low-value tool result');
    assert(r.messages.length === 3, 'no messages removed when all in protected tail');
}

// ── 5. targetTokens stops early ──
{
    const msgs = [];
    msgs.push({ role: 'user', content: 'start' });
    // 5 low-value tool results, each ~100 chars (25 tokens with default estimate).
    for (let i = 0; i < 5; i++) {
        msgs.push({ role: 'assistant', tool_calls: [{ id: 'c' + i, function: { name: 'grep' } }] });
        msgs.push({ role: 'tool', tool_call_id: 'c' + i, content: 'No matches found ' + 'x'.repeat(80) });
    }
    msgs.push({ role: 'user', content: 'end' });
    const r = dropLowValueToolOutput(msgs, { targetTokens: 40 });
    assert(r.dropped >= 1, 'dropped at least one to reach target');
    assert(r.stoppedAtTarget === true, 'stopped at target flag');
    assert(r.messages.length < msgs.length, 'messages removed');
}

// ── 6. never drops user/assistant text turns ──
{
    const msgs = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'important user instruction' },
        { role: 'assistant', content: 'Here is a detailed answer with real content that is long' },
        { role: 'user', content: 'another important user message that must stay' },
    ];
    const r = dropLowValueToolOutput(msgs);
    assert(r.dropped === 0, 'no tool messages to drop');
    assert(r.messages.length === 4, 'nothing removed when no tool results');
    assert(r.messages.some(m => m.role === 'user'), 'user turns untouched');
}

// ── 7. never throws on bad input ──
{
    let threw = false;
    try {
        dropLowValueToolOutput(undefined);
        dropLowValueToolOutput(null);
        dropLowValueToolOutput([null, undefined, { role: 'tool', content: 'No matches found' }]);
        dropLowValueToolOutput([{ role: 'tool', content: 'No matches found' }], { targetTokens: -5 });
        dropLowValueToolOutput([{ role: 'tool' }], { estimate: () => { throw new Error('boom'); } });
    } catch (e) {
        threw = true;
        console.error('  threw: ' + e);
    }
    assert(!threw, 'never throws on bad input / throwing estimator');
}

console.log('');
console.log(`test-budget: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('Failures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
