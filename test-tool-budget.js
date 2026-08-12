// test-tool-budget.js — mirrors src/tools/budget.ts (v0.7.86 tool-description
// token budget). Pure module — no vscode dependency.
const assert = require('assert');
const {
    trimToolDescriptions,
    estimateToolTokens,
    DEFAULT_TOOL_BUDGET_TOKENS,
    MIN_KEEP_CHARS,
} = require('./out/tools/budget.js');

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

function makeTool(name, description, paramLen = 8) {
    return {
        type: 'function',
        name,
        description,
        parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
    };
}

// --- constants ---
check('default budget is 12000', () => {
    assert.strictEqual(DEFAULT_TOOL_BUDGET_TOKENS, 12000);
});
check('min keep chars is 120', () => {
    assert.strictEqual(MIN_KEEP_CHARS, 120);
});

// --- no-op under budget ---
check('under budget → no trimming', () => {
    const tools = [makeTool('a', 'short'), makeTool('b', 'short too')];
    const r = trimToolDescriptions(tools, { budgetTokens: 100000 });
    assert.strictEqual(r.trimmed, 0);
    assert.strictEqual(r.tools.length, 2);
    assert.strictEqual(r.tools[0].description, 'short');
});

// --- empty ---
check('empty tool list', () => {
    const r = trimToolDescriptions([]);
    assert.strictEqual(r.tools.length, 0);
    assert.strictEqual(r.trimmed, 0);
});

// --- over budget trims the longest ---
check('over budget trims descriptions to fit', () => {
    // Each tool description ~600 chars (~150 tokens) + params; 8 tools ~ 1600 tokens.
    const tools = [];
    for (let i = 0; i < 8; i++) {
        tools.push(makeTool(`tool_${i}`, `Description ${i} `.repeat(60)));
    }
    const total = estimateToolTokens(tools);
    const r = trimToolDescriptions(tools, { budgetTokens: 800 });
    assert.ok(total > 800, `expected total ${total} over budget`);
    assert.ok(r.trimmed > 0, 'some tools trimmed');
    const after = estimateToolTokens(r.tools);
    assert.ok(after <= 800, `fits budget: ${after} <= 800`);
    assert.ok(r.savedTokens > 0, 'saved tokens > 0');
});

// --- names + parameters preserved verbatim ---
check('names and parameters preserved after trimming', () => {
    const tools = [makeTool('keep_me', 'X '.repeat(300), 12)];
    const before = JSON.stringify(tools[0].parameters);
    const r = trimToolDescriptions(tools, { budgetTokens: 50 });
    assert.strictEqual(r.tools[0].name, 'keep_me');
    assert.strictEqual(JSON.stringify(r.tools[0].parameters), before);
    assert.ok(r.tools[0].description.length <= MIN_KEEP_CHARS);
});

// --- result does not mutate the input ---
check('input tools are not mutated', () => {
    const tools = [makeTool('a', 'Y '.repeat(400))];
    const snapshot = tools[0].description;
    trimToolDescriptions(tools, { budgetTokens: 50 });
    assert.strictEqual(tools[0].description, snapshot);
});

// --- chat shape ({ function: {...} }) ---
check('chat shape ({function}) is supported', () => {
    const tools = [{
        type: 'function',
        function: {
            name: 'chat_tool',
            description: 'Z '.repeat(400),
            parameters: { type: 'object', properties: {}, required: [] },
        },
    }];
    const r = trimToolDescriptions(tools, { budgetTokens: 50 });
    assert.ok(r.trimmed === 1);
    assert.strictEqual(r.tools[0].function.name, 'chat_tool');
    assert.ok(r.tools[0].function.description.length <= MIN_KEEP_CHARS);
});

// --- saturated: everything minimal but still over budget ---
check('saturated when nothing left to trim', () => {
    // 500 tools, each with a tiny description, tiny budget → all trimmed → saturated.
    const tools = [];
    for (let i = 0; i < 500; i++) {
        tools.push(makeTool(`t${i}`, 'hi'));
    }
    const r = trimToolDescriptions(tools, { budgetTokens: 10 });
    assert.strictEqual(r.saturated, true);
});

// --- minimum budget enforcement ---
check('budget below minimum falls back to default', () => {
    const tools = [makeTool('a', 'ok'), makeTool('b', 'also ok')];
    const r = trimToolDescriptions(tools, { budgetTokens: -1 });
    assert.strictEqual(r.trimmed, 0); // default budget is huge → no trim
});

// --- estimateToolTokens basic ---
check('estimateToolTokens counts description chars/4', () => {
    const tools = [makeTool('abc', '1234')]; // 3 + 4 + params json
    const est = estimateToolTokens(tools);
    assert.ok(est > 0);
});

console.log(`\ntest-tool-budget: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
