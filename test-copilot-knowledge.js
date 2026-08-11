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
    const enriched = augmentToolDescription('read', 'Read a file');
    check('enriches known tool', enriched.includes('Read files in the workspace'));
    check('keeps when-to-use', enriched.includes('When to use:'));
    check('keeps original content folded in', enriched.length > 'Read a file'.length);

    const passthrough = augmentToolDescription('mystery_tool_xyz', 'Original desc');
    check('unknown tool passes through unchanged', passthrough === 'Original desc');

    const terminal = augmentToolDescription('runInTerminal', 'Run a command');
    check('terminal tool includes caution', terminal.includes('Caution:'));
}

// ── 2. Catalog access ─────────────────────────────────────────────────────
console.log('\n=== 2. Catalog access ===');
{
    check('browser tool known', getToolKnowledge('clickElement')?.category === 'browser');
    check('edit tool known', getToolKnowledge('edit')?.category === 'edit');
    check('read tool known (file)', getToolKnowledge('read')?.category === 'file');
    check('unknown tool undefined', getToolKnowledge('nope_nope') === undefined);
}

// ── 3. categorizeTools ───────────────────────────────────────────────────
console.log('\n=== 3. categorizeTools ===');
{
    const cats = categorizeTools(['read', 'search', 'runInTerminal', 'clickElement', 'zzz_unknown']);
    check('groups file', cats['file']?.includes('read'));
    check('groups search', cats['search']?.includes('search'));
    check('groups terminal', cats['terminal']?.includes('runInTerminal'));
    check('groups browser', cats['browser']?.includes('clickElement'));
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
    check('createFile known', getToolKnowledge('createFile')?.category === 'edit');
    check('listDirectory known (search)', getToolKnowledge('listDirectory')?.category === 'search');
    check('problems known (diagnostics)', getToolKnowledge('problems')?.category === 'diagnostics');
    check('fetch known (web)', getToolKnowledge('fetch')?.category === 'web');
    check('web known (web)', getToolKnowledge('web')?.category === 'web');
    check('githubRepo known', getToolKnowledge('githubRepo')?.category === 'web');
    check('notebook tool known', getToolKnowledge('createJupyterNotebook')?.category === 'notebook');
    check('vscodeAPI known (vscode)', getToolKnowledge('vscodeAPI')?.category === 'vscode');
    check('todo known (task)', getToolKnowledge('todo')?.category === 'task');
    check('browser umbrella known', getToolKnowledge('browser')?.category === 'browser');
    check('containerToolsConfig known', getToolKnowledge('containerToolsConfig')?.category === 'container');
    check('unknown still undefined', getToolKnowledge('zzz_not_a_tool') === undefined);

    // Every expanded entry must produce an enriched description with the
    // "When to use" hint.
    const enriched = augmentToolDescription('editFiles', 'Edit');
    check('editFiles enrichment has when-to-use', enriched.includes('When to use:'));
    check('editFiles enrichment has caution', enriched.includes('Caution:'));

    const web = augmentToolDescription('fetch', 'Fetch page');
    check('web tool enrichment present', web.length > 'Fetch page'.length);

    const cats = categorizeTools(['problems', 'editFiles', 'fetch', 'createJupyterNotebook', 'todo']);
    check('categorize new categories', cats['diagnostics']?.includes('problems') &&
        cats['edit']?.includes('editFiles') &&
        cats['web']?.includes('fetch') &&
        cats['notebook']?.includes('createJupyterNotebook') &&
        cats['task']?.includes('todo'));
}

// ── 7. Snake-case Copilot-agent toolset (from bundle) ─────────────────────
console.log('\n=== 7. Snake-case Copilot-agent toolset ===');
{
    check('read_file known', getToolKnowledge('read_file')?.category === 'file');
    check('grep_search known (search)', getToolKnowledge('grep_search')?.category === 'search');
    check('run_in_terminal known', getToolKnowledge('run_in_terminal')?.category === 'terminal');
    check('replace_string_in_file known (edit)', getToolKnowledge('replace_string_in_file')?.category === 'edit');
    check('click_element known (browser)', getToolKnowledge('click_element')?.category === 'browser');
    check('run_notebook_cell known (notebook)', getToolKnowledge('run_notebook_cell')?.category === 'notebook');
    check('manage_todo_list known (task)', getToolKnowledge('manage_todo_list')?.category === 'task');
    check('vscode_askQuestions known (vscode)', getToolKnowledge('vscode_askQuestions')?.category === 'vscode');
    check('fetch_webpage known (web)', getToolKnowledge('fetch_webpage')?.category === 'web');
    check('runSubagent known (task)', getToolKnowledge('runSubagent')?.category === 'task');
    check('write_file known (edit)', getToolKnowledge('write_file')?.category === 'edit');

    // The full real snake_case list from the bundle must all be present.
    const realNames = [
        'manage_todo_list', 'tool_search', 'vscode_askQuestions', 'switch_agent',
        'vscode_get_confirmation', 'vscode_get_confirmation_with_options',
        'vscode_get_terminal_confirmation', 'vscode_reviewPlan',
        'resolve_memory_file_uri', 'memory', 'skill', 'session_store_sql',
        'edit_files', 'semantic_search', 'file_search', 'grep_search',
        'read_file', 'view_image', 'list_dir', 'read_project_structure',
        'search_workspace_symbols', 'get_changed_files', 'fetch_webpage',
        'github_repo', 'github_text_search', 'test_search',
        'copilot_getNotebookSummary', 'read_notebook_cell_output',
        'testFailure', 'run_in_terminal', 'send_to_terminal',
        'get_terminal_output', 'kill_terminal', 'terminal_selection',
        'terminal_last_command', 'get_task_output', 'open_browser_page',
        'screenshot_page', 'navigate_page', 'read_page', 'run_playwright_code',
        'runSubagent', 'get_errors', 'install_extension', 'apply_patch',
        'create_directory', 'create_file', 'create_new_jupyter_notebook',
        'insert_edit_into_file', 'edit_notebook_file',
        'multi_replace_string_in_file', 'replace_string_in_file',
        'create_and_run_task', 'run_task', 'runTests', 'run_notebook_cell',
        'semantic_search', 'get_vscode_api', 'read_project_structure',
        'search_subagent', 'explore_subagent', 'tool_search', 'task_complete',
        'vscode_renameSymbol', 'vscode_listCodeUsages',
    ];
    const missing = realNames.filter(n => !getToolKnowledge(n));
    check('all real bundle snake_case names present', missing.length === 0, 'missing: ' + missing.join(', '));

    // Enrichment works for a snake_case tool too.
    const enr = augmentToolDescription('run_in_terminal', 'Run a command');
    check('snake terminal enrichment has caution', enr.includes('Caution:'));
}

console.log(`\n===== ${safe} passed, ${failures} failed =====`);
process.exit(failures === 0 ? 0 : 1);
