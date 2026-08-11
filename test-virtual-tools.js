// Tests the embeddings-based virtual-tool expansion module
// (src/harness/virtualTools.ts) — mirrors Copilot Chat's activate_* mechanism.
// Run: node test-virtual-tools.js
const {
    expandVirtualTools,
    tokenize,
    EMBEDDINGS_GROUP,
    assertVirtualGroupName,
    LexicalOverlapMatcher,
} = require('./out/harness/virtualTools.js');

let safe = 0;
let failures = 0;
function check(name, cond, detail) {
    if (cond) { safe++; console.log(`  PASS ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const groups = [
    {
        name: 'activate_file_ops',
        metadata: { wasEmbeddingsMatched: false, wasExpandedByDefault: true, canBeCollapsed: false },
        tools: [
            { name: 'read_file', description: 'Read file contents from disk' },
            { name: 'edit_file', description: 'Edit a file in the workspace' },
        ],
    },
    {
        name: EMBEDDINGS_GROUP,
        metadata: { wasEmbeddingsMatched: false, wasExpandedByDefault: false, canBeCollapsed: true },
        tools: [
            { name: 'grep_search', description: 'Search for text patterns across files' },
            { name: 'run_terminal', description: 'Run a shell command in the terminal' },
            { name: 'web_fetch', description: 'Fetch content from a web page' },
            { name: 'list_dir', description: 'List directory contents' },
        ],
    },
    {
        name: 'activate_browser',
        metadata: { wasEmbeddingsMatched: false, wasExpandedByDefault: false, canBeCollapsed: true },
        tools: [
            { name: 'open_page', description: 'Open a browser page at a URL' },
            { name: 'screenshot', description: 'Capture a screenshot of the page' },
        ],
    },
];

// ── 1. Name validation ───────────────────────────────────────────────────
console.log('\n=== 1. Virtual group name validation ===');
check('valid activate_ name passes', (() => { try { assertVirtualGroupName('activate_x'); return true; } catch { return false; } })());
check('non-activate_ name throws', (() => { try { assertVirtualGroupName('plain_group'); return false; } catch { return true; } })());
check('embeddings group name is activate_embeddings', EMBEDDINGS_GROUP === 'activate_embeddings');

// ── 2. Tokenizer ──────────────────────────────────────────────────────────
console.log('\n=== 2. Tokenizer ===');
check('lowercases + strips punctuation', tokenize('Search FILES for X!').has('files'));
check('drops stopwords', !tokenize('help me search').has('me'));
check('drops single chars', !tokenize('a b c search').has('a'));
check('keeps underscores', tokenize('read_file').has('read_file'));

// ── 3. Always-shown groups are always present ─────────────────────────────
console.log('\n=== 3. Always-shown groups ===');
{
    const { tools } = expandVirtualTools(groups, '', { threshold: 128 });
    const names = tools.map(t => t.name);
    check('file_ops always expanded by default', names.includes('read_file') && names.includes('edit_file'));
    check('empty query keeps only always-shown + nothing matched', names.length === 2, `got ${names.join(',')}`);
}

// ── 4. Embedding-matched expansion by query ───────────────────────────────
console.log('\n=== 4. Embedding-matched expansion ===');
{
    const { tools, expanded } = expandVirtualTools(groups, 'search across files for patterns', { threshold: 1 });
    const names = tools.map(t => t.name);
    check('grep_search matched', names.includes('grep_search'));
    check('run_terminal not matched by search query', !names.includes('run_terminal'));
    check('web_fetch not matched by search query', !names.includes('web_fetch'));
    check('expanded report includes matched tool', expanded.some(m => m.candidate.name === 'grep_search'));
}
{
    const { tools } = expandVirtualTools(groups, 'fetch content from a web page url', { threshold: 1 });
    const names = tools.map(t => t.name);
    check('web_fetch matched by web query', names.includes('web_fetch'));
    check('browser open_page matched by web query', names.includes('open_page'));
    check('file read always-shown regardless of query', names.includes('read_file')); // always-shown
}

// ── 5. Threshold behavior ─────────────────────────────────────────────────
console.log('\n=== 5. Threshold gating ===');
{
    // threshold 0 = off → all collapsible tools expand
    const { tools } = expandVirtualTools(groups, 'search files', { threshold: 0 });
    check('threshold 0 expands everything', tools.length >= 8, `got ${tools.length}`);
}
{
    // very high threshold → only always-shown tools survive (nothing matched)
    const { tools } = expandVirtualTools(groups, 'search files for text patterns across code', { threshold: 1000 });
    check('high threshold keeps always-shown only', tools.length === 2, `got ${tools.length}`);
}
{
    // threshold 3 = requires both a name and/or enough description terms
    const { tools } = expandVirtualTools(groups, 'grep search files for text patterns across code', { threshold: 3 });
    check('threshold 3 still surfaces grep_search (name+desc terms)', tools.some(t => t.name === 'grep_search'));
}

// ── 6. Dedup ──────────────────────────────────────────────────────────────
console.log('\n=== 6. Dedup across groups ===');
{
    const dupGroups = [
        { name: 'activate_a', metadata: { wasEmbeddingsMatched: false, wasExpandedByDefault: true, canBeCollapsed: false }, tools: [{ name: 'shared', description: 'shared tool' }] },
        { name: EMBEDDINGS_GROUP, metadata: { wasEmbeddingsMatched: false, wasExpandedByDefault: false, canBeCollapsed: true }, tools: [{ name: 'shared', description: 'shared tool described as shared across code' }] },
    ];
    const { tools } = expandVirtualTools(dupGroups, 'shared tool', { threshold: 128 });
    const count = tools.filter(t => t.name === 'shared').length;
    check('duplicate tool name appears once', count === 1, `got ${count}`);
}

// ── 7. Max tools budget (128 DeepSeek limit) ──────────────────────────────
console.log('\n=== 7. Max tools budget ===');
{
    const many = [{ name: EMBEDDINGS_GROUP, metadata: { wasEmbeddingsMatched: false, wasExpandedByDefault: false, canBeCollapsed: true }, tools: Array.from({ length: 200 }, (_, i) => ({ name: `tool_${i}`, description: `a generic tool number ${i} for testing` })) }];
    const { tools } = expandVirtualTools(many, 'tool', { threshold: 1, maxTools: 128 });
    check('capped at maxTools=128', tools.length === 128, `got ${tools.length}`);
}

// ── 8. Custom matcher pluggability ────────────────────────────────────────
console.log('\n=== 8. Custom matcher ===');
{
    class ReverseMatcher {
        score(candidates, query) { return [...candidates].reverse().map(c => ({ candidate: c, score: 1 })); }
    }
    const { tools } = expandVirtualTools(groups, 'anything', { threshold: 1 }, new ReverseMatcher());
    check('custom matcher used (all collapsible matched)', tools.length >= 6, `got ${tools.length}`);
}

// ── 9. Lexical matcher scoring sanity ─────────────────────────────────────
console.log('\n=== 9. Matcher scoring ===');
{
    const matcher = new LexicalOverlapMatcher();
    const scored = matcher.score(
        [{ name: 'foo_bar', description: 'foos the bar and baz' }, { name: 'baz_qux', description: 'qux stuff' }],
        'bar baz',
    );
    check('name match outranks description-only', scored[0].candidate.name === 'foo_bar', `got ${scored[0].candidate.name}`);
    check('scores descending', scored[0].score >= scored[1].score);
}

console.log(`\n===== ${safe} passed, ${failures} failed =====`);
process.exit(failures === 0 ? 0 : 1);
