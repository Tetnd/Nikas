// Tests the full agent harness: toolSummarizer, agentLoop, facade, and the
// real tool executors (using a temp dir). The loop/summarizer are driven with
// mocks so no network calls happen.
// Run: node test-agent.js
const { parseCategoryArray, selectToolsForTask } = require('./out/harness/toolSummarizer.js');
const { runAgentLoop } = require('./out/harness/agentLoop.js');
const { runAgent, toVirtualGroups } = require('./out/harness/index.js');
const { DEFAULT_TOOLSET, FILE_READ, FILE_WRITE, SEARCH, TERMINAL } = require('./out/harness/tools/index.js');
const { guardToolHistory, estimateTextTokens } = require('./out/harness/estimate.js');
const os = require('os');
const fs = require('fs');
const path = require('path');

(async () => {
let safe = 0;
let failures = 0;
function check(name, cond, detail) {
    if (cond) { safe++; console.log(`  PASS ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

// ── 1. Summarizer: parseCategoryArray ────────────────────────────────────
console.log('\n=== 1. parseCategoryArray ===');
check('plain array', JSON.stringify(parseCategoryArray('["a","b"]')) === JSON.stringify(['a', 'b']));
check('array with prose around', JSON.stringify(parseCategoryArray('Here: ["activate_x"] ok')) === JSON.stringify(['activate_x']));
check('fenced json', JSON.stringify(parseCategoryArray('```json\n["a"]\n```')) === JSON.stringify(['a']));
check('no array returns undefined', parseCategoryArray('no categories') === undefined);
check('invalid json array returns undefined', parseCategoryArray('[a,b') === undefined);
check('filters non-strings', JSON.stringify(parseCategoryArray('["a", 1, null]')) === JSON.stringify(['a']));

// ── 2. Summarizer: selectToolsForTask ────────────────────────────────────
console.log('\n=== 2. selectToolsForTask ===');
{
    const groups = [
        { name: 'activate_fixed', metadata: { wasExpandedByDefault: true, canBeCollapsed: false, wasEmbeddingsMatched: false }, tools: [{ name: 'read_file', description: 'r' }] },
        { name: 'activate_search', metadata: { canBeCollapsed: true, wasExpandedByDefault: false, wasEmbeddingsMatched: false }, tools: [{ name: 'grep_search', description: 'g' }] },
        { name: 'activate_embeddings', metadata: { canBeCollapsed: true, wasExpandedByDefault: false, wasEmbeddingsMatched: false }, tools: [{ name: 'web_fetch', description: 'w' }] },
    ];
    // selector picks only 'activate_search'
    const picked = await selectToolsForTask(groups, 'find code', {
        select: async (task, g) => ['activate_search'],
    });
    const names = picked.map(t => t.name);
    check('always-shown included', names.includes('read_file'));
    check('embeddings group included (fixed)', names.includes('web_fetch'));
    check('picked collapsible included', names.includes('grep_search'));
    check('other collapsible excluded', names.length === 3, `got ${names.join(',')}`);
}
{
    const groups = [
        { name: 'activate_fixed', metadata: { wasExpandedByDefault: true, canBeCollapsed: false, wasEmbeddingsMatched: false }, tools: [{ name: 'a', description: 'x' }] },
        { name: 'activate_b', metadata: { canBeCollapsed: true, wasExpandedByDefault: false, wasEmbeddingsMatched: false }, tools: [{ name: 'b', description: 'y' }] },
    ];
    // no selector → all collapsible expanded
    const picked = await selectToolsForTask(groups, 'task', undefined);
    const names = picked.map(t => t.name);
    check('no selector expands all collapsible', names.includes('b') && names.includes('a'));
    // selector returns undefined → fallback to all
    const picked2 = await selectToolsForTask(groups, 'task', { select: async () => undefined });
    check('selector undefined falls back to all', picked2.map(t => t.name).includes('b'));
}

// ── 3. Real tool executors (temp dir) ────────────────────────────────────
console.log('\n=== 3. Tool executors ===');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikas-agent-'));
    try {
        const write = await FILE_WRITE.execute({ path: 'src/a.txt', content: 'hello world hello' }, dir);
        check('write_file succeeds', write.includes('wrote'));
        const read = await FILE_READ.execute({ path: 'src/a.txt' }, dir);
        check('read_file returns content', read === 'hello world hello');
        const missing = await FILE_READ.execute({ path: 'nope.txt' }, dir);
        check('read_file missing returns error', missing.includes('[error reading'));
        const search = await SEARCH.execute({ pattern: 'hello', dir: 'src' }, dir);
        check('search finds match', search.includes('a.txt'));
        const nosearch = await SEARCH.execute({ pattern: 'zzzznope', dir: 'src' }, dir);
        check('search no-match message', nosearch.includes('no matches'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── 4. Agent loop with mock transport ────────────────────────────────────
console.log('\n=== 4. Agent loop (mock transport) ===');
{
    // Scripted turns: turn 1 → call write_file; turn 2 → done.
    let turn = 0;
    const mockTransport = async (request, apiKey, signal, onText, onToolCalls) => {
        turn++;
        if (turn === 1) {
            onToolCalls([{ id: 'call_1', name: 'write_file', arguments: { path: 'out.txt', content: 'hi' } }]);
            onText('writing...');
            return { receivedContent: true, receivedToolCalls: true, finishReason: 'tool_calls' };
        }
        onText('done.');
        return { receivedContent: true, receivedToolCalls: false, finishReason: 'stop' };
    };
    const logs = [];
    const result = await runAgentLoop('make a file', {
        apiKey: 'k',
        cwd: os.tmpdir(),
        tools: DEFAULT_TOOLSET,
        transport: mockTransport,
        onLog: (m) => logs.push(m),
        executor: async (tool, args) => {
            check('executor ran write_file', tool.name === 'write_file');
            return '[wrote]';
        },
    });
    check('loop completed', result.completed);
    check('loop iterations = 2', result.iterations === 2, `got ${result.iterations}`);
    check('loop text includes both chunks', result.text.includes('writing...') && result.text.includes('done.'));
    check('loop executed 1 tool call', result.toolCalls === 1, `got ${result.toolCalls}`);
    check('sequence records tool names in order', JSON.stringify(result.sequence) === JSON.stringify(['write_file']), `got ${JSON.stringify(result.sequence)}`);
    check('onLog captured exec line', logs.some(l => l.includes('exec write_file')), `got ${JSON.stringify(logs)}`);
    check('onLog captured done line', logs.some(l => l.includes('done after')), `got ${JSON.stringify(logs)}`);
}

// ── 5. Agent loop: maxIterations truncation ──────────────────────────────
console.log('\n=== 5. Agent loop maxIterations ===');
{
    let calls = 0;
    const mockTransport = async (request, apiKey, signal, onText, onToolCalls) => {
        calls++;
        onToolCalls([{ id: 'c' + calls, name: 'read_file', arguments: { path: 'x' } }]);
        return { receivedContent: false, receivedToolCalls: true, finishReason: 'tool_calls' };
    };
    const result = await runAgentLoop('loop forever', {
        apiKey: 'k',
        cwd: os.tmpdir(),
        tools: [FILE_READ],
        maxIterations: 3,
        transport: mockTransport,
        executor: async () => '[]',
    });
    check('truncated at maxIterations', result.truncated);
    check('iterations == maxIterations', result.iterations === 3, `got ${result.iterations}`);
    check('toolCalls == 3', result.toolCalls === 3, `got ${result.toolCalls}`);
    check('truncated sequence has 3 read_file', result.sequence.length === 3 && result.sequence.every(n => n === 'read_file'), `got ${JSON.stringify(result.sequence)}`);
}

// ── 6. Agent loop: unknown tool ──────────────────────────────────────────
console.log('\n=== 6. Agent loop unknown tool ===');
{
    let turn = 0;
    const mockTransport = async (request, apiKey, signal, onText, onToolCalls) => {
        turn++;
        if (turn === 1) { onToolCalls([{ id: 'c1', name: 'ghost_tool', arguments: {} }]); return { receivedContent: false, receivedToolCalls: true, finishReason: 'tool_calls' }; }
        onText('ok'); return { receivedContent: true, receivedToolCalls: false, finishReason: 'stop' };
    };
    let fedResult = '';
    const result = await runAgentLoop('use ghost', {
        apiKey: 'k', cwd: os.tmpdir(), tools: [FILE_READ], transport: mockTransport,
        executor: async (tool, args) => { fedResult = 'EXEC'; return 'EXEC'; },
    });
    check('loop completes despite unknown tool', result.completed);
}

// ── 7. Facade: runAgent wires summarizer + loop ──────────────────────────
console.log('\n=== 7. Facade runAgent ===');
{
    let turn = 0;
    const mockTransport = async (request, apiKey, signal, onText, onToolCalls) => {
        turn++;
        if (turn === 1) { onToolCalls([{ id: 'c1', name: 'read_file', arguments: { path: 'f' } }]); return { receivedContent: false, receivedToolCalls: true, finishReason: 'tool_calls' }; }
        onText('final answer'); return { receivedContent: true, receivedToolCalls: false, finishReason: 'stop' };
    };
    const result = await runAgent('inspect file f', {
        apiKey: 'k',
        cwd: os.tmpdir(),
        tools: DEFAULT_TOOLSET,
        alwaysShown: ['read_file'],
        collapsible: ['run_terminal'],
        transport: mockTransport,
        executor: async (tool, args) => {
            check('facade scoped toolset passed through', tool.name === 'read_file');
            return 'file contents';
        },
    });
    check('facade result completed', result.completed);
    check('facade result has final text', result.text.includes('final answer'));
}

// ── 8. toVirtualGroups ───────────────────────────────────────────────────
console.log('\n=== 8. toVirtualGroups ===');
{
    const groups = toVirtualGroups(DEFAULT_TOOLSET, { alwaysShown: ['read_file'], collapsible: ['run_terminal'] });
    const all = groups.flatMap(g => g.tools.map(t => t.name));
    check('embeddings group exists', groups.some(g => g.name === 'activate_embeddings'));
    check('fixed group contains read_file', groups.find(g => g.name === 'activate_fixed')?.tools.some(t => t.name === 'read_file'));
    check('collapsible group for run_terminal', groups.some(g => g.name === 'activate_run_terminal'));
    check('all tools represented', all.length === DEFAULT_TOOLSET.length, `got ${all.length}`);
}

// ── 9. Context guard ──────────────────────────────────────────────────────
console.log('\n=== 9. Context guard ===');
{
    const msgs = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'a1', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'big '.repeat(10000) },
        { role: 'assistant', content: 'a2', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'x', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c2', content: 'big '.repeat(10000) },
    ];
    const est = estimateTextTokens(msgs[3].content);
    check('estimator counts big content', est > 5000, `got ${est}`);
    const guarded = guardToolHistory(msgs, { maxHistoryTokens: 2000, keepNewest: 1 });
    check('guard drops oldest tool pair when over budget', guarded.length < msgs.length, `got ${guarded.length}`);
    check('guard keeps system+user', guarded[0].role === 'system' && guarded[1].role === 'user');
    check('guard keeps newest tool result', guarded.some(m => m.tool_call_id === 'c2'));
    check('guard drops oldest tool result', !guarded.some(m => m.tool_call_id === 'c1'));
    const under = guardToolHistory(msgs, { maxHistoryTokens: 10_000_000 });
    check('guard no-op when under budget', under.length === msgs.length);
}

// ── 10. Structured results, retry, verify, transport retry, parallel ──────
console.log('\n=== 10. Structured results, retry, verify, parallel ===');
{
    // Transient tool retry: executor fails transiently twice then succeeds.
    let turn = 0;
    let attempts = 0;
    const mockTransport = async (request, apiKey, signal, onText, onToolCalls) => {
        turn++;
        if (turn === 1) { onToolCalls([{ id: 'c1', name: 'run_terminal', arguments: { command: 'x' } }]); return { receivedContent: false, receivedToolCalls: true, finishReason: 'tool_calls' }; }
        onText('ok'); return { receivedContent: true, receivedToolCalls: false, finishReason: 'stop' };
    };
    const r1 = await runAgentLoop('retry me', {
        apiKey: 'k', cwd: os.tmpdir(), tools: DEFAULT_TOOLSET, transport: mockTransport, toolRetries: 2,
        executor: async () => { attempts++; if (attempts <= 2) return 'network timeout'; return 'ok now'; },
    });
    check('tool retried on transient', attempts === 3, `got ${attempts}`);
    check('loop completes after retry', r1.completed);
}
{
    // Verify command runs after completion.
    let turn = 0;
    let verifyRan = false;
    const mockTransport = async (request, apiKey, signal, onText, onToolCalls) => {
        turn++;
        onText('done'); return { receivedContent: true, receivedToolCalls: false, finishReason: 'stop' };
    };
    const r2 = await runAgentLoop('do it', {
        apiKey: 'k', cwd: os.tmpdir(), tools: DEFAULT_TOOLSET, transport: mockTransport, verifyCommand: 'npm test',
        executor: async (tool, args) => { if (tool.name === 'run_verify') { verifyRan = true; return '[command failed]\n1 failing'; } return 'x'; },
    });
    check('verify command ran', verifyRan);
    check('verify result ok=false', r2.verify && r2.verify.ok === false);
    check('verify tag=command-failed', r2.verify && r2.verify.tag === 'command-failed');
}
{
    // Transport retry on transient API error.
    let calls = 0;
    let turn = 0;
    const mockTransport = async (request, apiKey, signal, onText, onToolCalls) => {
        calls++;
        if (calls === 1) throw new Error('ECONNRESET network');
        turn++;
        onText('ok'); return { receivedContent: true, receivedToolCalls: false, finishReason: 'stop' };
    };
    const r3 = await runAgentLoop('x', { apiKey: 'k', cwd: os.tmpdir(), tools: [FILE_READ], transport: mockTransport, apiRetries: 2 });
    check('transport retried on transient API error', calls === 2, `got ${calls}`);
    check('loop completed after api retry', r3.completed);
}
{
    // Parallel execution: 3 independent tool calls in one turn.
    let turn = 0;
    let maxConcurrent = 0;
    let active = 0;
    const mockTransport = async (request, apiKey, signal, onText, onToolCalls) => {
        turn++;
        if (turn === 1) {
            onToolCalls([
                { id: 'c1', name: 'read_file', arguments: { path: 'a' } },
                { id: 'c2', name: 'read_file', arguments: { path: 'b' } },
                { id: 'c3', name: 'read_file', arguments: { path: 'c' } },
            ]);
            return { receivedContent: false, receivedToolCalls: true, finishReason: 'tool_calls' };
        }
        onText('done'); return { receivedContent: true, receivedToolCalls: false, finishReason: 'stop' };
    };
    const r4 = await runAgentLoop('read 3 files', {
        apiKey: 'k', cwd: os.tmpdir(), tools: [FILE_READ], transport: mockTransport, maxParallel: 3,
        executor: async () => { active++; maxConcurrent = Math.max(maxConcurrent, active); await new Promise(r => setTimeout(r, 10)); active--; return 'data'; },
    });
    check('tool calls executed in parallel', maxConcurrent === 3, `got ${maxConcurrent}`);
    check('parallel loop completed', r4.completed);
}

console.log(`\n===== ${safe} passed, ${failures} failed =====`);
process.exit(failures === 0 ? 0 : 1);
})();