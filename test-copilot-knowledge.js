// Tests the Copilot-knowledge module (src/harness/copilotKnowledge.ts) that
// helps DeepSeek understand Copilot's native toolset.
// Run: node test-copilot-knowledge.js
const {
    augmentToolDescription,
    getToolKnowledge,
    knownCategories,
    categorizeTools,
    buildCopilotOperatingGuide,
} = require('./out/harness/copilotKnowledge.js');

let safe = 0;
let failures = 0;
function check(name, cond, detail) {
    if (cond) { safe++; console.log(`  PASS ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

// ── 1. augmentToolDescription ─────────────────────────────────────────────
console.log('\n=== 1. augmentToolDescription ===');
{
    const enriched = augmentToolDescription('read_file', 'Read a file');
    check('enriches known tool', enriched.includes('Read the contents of a file'));
    check('keeps when-to-use', enriched.includes('When to use:'));
    check('keeps original content folded in', enriched.length > 'Read a file'.length);

    const passthrough = augmentToolDescription('mystery_tool_xyz', 'Original desc');
    check('unknown tool passes through unchanged', passthrough === 'Original desc');

    const terminal = augmentToolDescription('run_in_terminal', 'Run a command');
    check('terminal tool includes caution', terminal.includes('Caution:'));
}

// ── 2. Catalog access ─────────────────────────────────────────────────────
console.log('\n=== 2. Catalog access ===');
{
    check('browser tool known', getToolKnowledge('click_element')?.category === 'browser');
    check('edit tool known', getToolKnowledge('replace_string_in_file')?.category === 'edit');
    check('unknown tool undefined', getToolKnowledge('nope_nope') === undefined);
}

// ── 3. categorizeTools ───────────────────────────────────────────────────
console.log('\n=== 3. categorizeTools ===');
{
    const cats = categorizeTools(['read_file', 'grep_search', 'run_in_terminal', 'click_element', 'zzz_unknown']);
    check('groups file', cats['file']?.includes('read_file'));
    check('groups search', cats['search']?.includes('grep_search'));
    check('groups terminal', cats['terminal']?.includes('run_in_terminal'));
    check('groups browser', cats['browser']?.includes('click_element'));
    check('unknown to other', cats['other']?.includes('zzz_unknown'));
}

// ── 4. Operating guide ────────────────────────────────────────────────────
console.log('\n=== 4. buildCopilotOperatingGuide ===');
{
    const guide = buildCopilotOperatingGuide();
    check('guide mentions running in Copilot Chat', guide.includes('Copilot Chat'));
    check('guide mentions browser tools', guide.includes('browser'));
    check('guide mentions structured [tool STATUS] framing', guide.includes('[tool') && guide.includes('STATUS'));
    check('guide mentions terminal/build', guide.includes('terminal'));
    check('guide is concise (< 1200 chars)', guide.length < 1200, `got ${guide.length}`);
    check('guide instructs end-to-end completion', guide.includes('end-to-end'));
}

// ── 5. knownCategories ───────────────────────────────────────────────────
console.log('\n=== 5. knownCategories ===');
{
    const cats = knownCategories();
    check('covers multiple categories', cats.length >= 4, `got ${cats.length}`);
    check('includes browser', cats.includes('browser'));
    check('includes edit', cats.includes('edit'));
}

// ── 6. Expanded catalog coverage ─────────────────────────────────────────
console.log('\n=== 6. Expanded catalog coverage ===');
{
    check('create_file known', getToolKnowledge('create_file')?.category === 'edit');
    check('list_dir known (search)', getToolKnowledge('list_dir')?.category === 'search');
    check('get_errors known (diagnostics)', getToolKnowledge('get_errors')?.category === 'diagnostics');
    check('fetch_webpage known (web)', getToolKnowledge('fetch_webpage')?.category === 'web');
    check('web_search known (web)', getToolKnowledge('web_search')?.category === 'web');
    check('github_repo_search known', getToolKnowledge('github_repo_search')?.category === 'web');
    check('notebook tool known', getToolKnowledge('create_new_jupyter_notebook')?.category === 'notebook');
    check('git tool known', getToolKnowledge('git_commit')?.category === 'git');
    check('manage_todo_list known (task)', getToolKnowledge('manage_todo_list')?.category === 'task');
    check('unknown still undefined', getToolKnowledge('zzz_not_a_tool') === undefined);

    // Every expanded entry must produce an enriched description with the
    // "When to use" hint.
    const enriched = augmentToolDescription('git_commit', 'Commit');
    check('git_commit enrichment has when-to-use', enriched.includes('When to use:'));
    check('git_commit enrichment has caution', enriched.includes('Caution:'));

    const web = augmentToolDescription('fetch_webpage', 'Fetch page');
    check('web tool enrichment present', web.length > 'Fetch page'.length);

    const cats = categorizeTools(['get_errors', 'git_commit', 'fetch_webpage', 'create_new_jupyter_notebook']);
    check('categorize new categories', cats['diagnostics']?.includes('get_errors') &&
        cats['git']?.includes('git_commit') &&
        cats['web']?.includes('fetch_webpage') &&
        cats['notebook']?.includes('create_new_jupyter_notebook'));
}

console.log(`\n===== ${safe} passed, ${failures} failed =====`);
process.exit(failures === 0 ? 0 : 1);
