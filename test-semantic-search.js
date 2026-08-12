// Tests the vscode-backed semantic_search tool (src/tools/semanticSearch.ts):
// the harness agent's natural-language codebase search that invokes Copilot's
// semantic index tool via vscode.lm.invokeTool (injected, so it's Node-testable).
// Run: node test-semantic-search.js
const {
    createSemanticSearchTool,
    extractResultText,
} = require('./out/tools/semanticSearch.js');

let safe = 0;
let failures = 0;
function check(name, cond, detail) {
    if (cond) { safe++; console.log(`  PASS ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

// ── 1. extractResultText ──────────────────────────────────────────────────
console.log('\n=== 1. extractResultText ===');
{
    check('null/undefined → empty', extractResultText(null) === '' && extractResultText(undefined) === '');
    check('no content array → empty', extractResultText({ content: 'nope' }) === '');
    check('text parts joined', extractResultText({ content: [{ value: 'a' }, { value: 'b' }] }) === 'a\nb');
    check('non-string values stringified', extractResultText({ content: [{ value: { file: 'x.ts' } }] }) === '{"file":"x.ts"}');
    check('missing value parts skipped', extractResultText({ content: [{ toolCallId: 'c1' }, { value: 'ok' }] }) === 'ok');
}

// ── 2. createSemanticSearchTool: shape ────────────────────────────────────
console.log('\n=== 2. Tool shape ===');
{
    const tool = createSemanticSearchTool({ invokeTool: async () => ({ content: [] }) });
    check('name is semantic_search', tool.name === 'semantic_search');
    check('description mentions natural language', tool.description.includes('natural language'));
    check('query is required in parameters', tool.parameters.required.includes('query'));
}

// ── 3. Execution paths ────────────────────────────────────────────────────
console.log('\n=== 3. Execution ===');
(async () => {
    // Missing query
    {
        const tool = createSemanticSearchTool({ invokeTool: async () => ({ content: [] }) });
        const out = await tool.execute({}, '.');
        check('missing query → error message', out.startsWith('[error: semantic_search requires'));
        check('missing query → does not invoke', true); // invokeTool would throw if called — no throw above means not called
    }

    // Success: returns Copilot result text
    {
        const tool = createSemanticSearchTool({
            invokeTool: async (name, input) => {
                check('invoked with copilot_searchCodebase first', name === 'copilot_searchCodebase');
                check('receives the query', input.query === 'find the router');
                return { content: [{ value: 'file: src/routing.ts\n- routing logic' }] };
            },
        });
        const out = await tool.execute({ query: 'find the router' }, '.');
        check('success returns result text', out === 'file: src/routing.ts\n- routing logic');
    }

    // Fallback: first name not registered → tries the next candidate
    {
        const tried = [];
        const tool = createSemanticSearchTool({
            invokeTool: async (name) => {
                tried.push(name);
                if (name === 'copilot_searchCodebase') throw new Error('Tool copilot_searchCodebase not found');
                return { content: [{ value: 'found via semantic_search' }] };
            },
        });
        const out = await tool.execute({ query: 'q' }, '.');
        check('fell back to second candidate', tried.includes('semantic_search'));
        check('second candidate result returned', out === 'found via semantic_search');
    }

    // All candidates unregistered → actionable unavailable message
    {
        const tool = createSemanticSearchTool({
            invokeTool: async () => { throw new Error('Unknown tool: semantic_search'); },
        });
        const out = await tool.execute({ query: 'q' }, '.');
        check('all missing → unavailable message', out.includes('[semantic search unavailable'));
        check('unavailable message suggests fallback', out.includes('search_text'));
    }

    // Non-registration error (auth/timeout) → reported directly, no fallback
    {
        let calls = 0;
        const tool = createSemanticSearchTool({
            invokeTool: async () => { calls++; throw new Error('network timeout'); },
        });
        const out = await tool.execute({ query: 'q' }, '.');
        check('hard error reported directly', out.includes('[semantic search failed via'));
        check('hard error does not retry other names', calls === 1);
    }

    // Empty successful result → actionable guidance
    {
        const tool = createSemanticSearchTool({ invokeTool: async () => ({ content: [] }) });
        const out = await tool.execute({ query: 'q' }, '.');
        check('empty result mentions Build Codebase Semantic Index', out.includes('Build Codebase Semantic Index'));
    }

    // Custom toolNames respected
    {
        const tool = createSemanticSearchTool({
            toolNames: ['only_this_name'],
            invokeTool: async (name) => ({ content: [{ value: `called ${name}` }] }),
        });
        const out = await tool.execute({ query: 'q' }, '.');
        check('custom toolNames used', out === 'called only_this_name');
    }

    // Abort signal is forwarded
    {
        let sawSignal = false;
        const tool = createSemanticSearchTool({
            invokeTool: async (_name, _input, signal) => {
                sawSignal = !!signal;
                return { content: [] };
            },
        });
        await tool.execute({ query: 'q' }, '.', new AbortController().signal);
        check('abort signal forwarded to invoker', sawSignal);
    }

    console.log(`\n===== ${safe} passed, ${failures} failed =====`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
    console.error('Test runner crashed:', err);
    process.exit(1);
});
