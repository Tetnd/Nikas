// Tests the Copilot-knowledge module (src/harness/copilotKnowledge.ts) that
// helps DeepSeek understand Copilot's native toolset.
// Run: node test-copilot-knowledge.js
const {
    augmentToolDescription,
    getToolKnowledge,
    knownCategories,
    categorizeTools,
} = require('./out/harness/copilotKnowledge.js');

let safe = 0;
let failures = 0;
function check(name, cond, detail) {
    if (cond) { safe++; console.log(`  PASS ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

// ── 1. augmentToolDescription (ADDITIVE: keeps the real description) ─────
// v0.7.76: the catalog no longer REPLACES the description Copilot sends.
// The real (Microsoft-authored) description is kept verbatim and only
// DeepSeek-specific guidance (When to use / Caution / Prefer) is appended.
console.log('\n=== 1. augmentToolDescription ===');
{
    const enriched = augmentToolDescription('read', 'Read a file');
    check('keeps the REAL original description verbatim', enriched.startsWith('Read a file'));
    check('appends when-to-use guidance', enriched.includes('When to use:'));
    check('original kept + guidance longer than original', enriched.length > 'Read a file'.length);

    const passthrough = augmentToolDescription('mystery_tool_xyz', 'Original desc');
    check('unknown tool passes through unchanged', passthrough === 'Original desc');

    const terminal = augmentToolDescription('runInTerminal', 'Run a command');
    check('terminal tool includes caution', terminal.includes('Caution:'));

    // A real tool with a real source description keeps BOTH the source text
    // (modelDescription) and our guidance.
    const readFile = augmentToolDescription('read_file', 'Read the contents of a file. Line numbers are 1-indexed.');
    check('read_file keeps the REAL source description', readFile.startsWith('Read the contents of a file. Line numbers are 1-indexed.'));
    check('read_file appends prefer guidance', readFile.includes('Prefer:'));

    // Empty original falls back to the catalog enrichedDescription (still enriched).
    const empty = augmentToolDescription('read_file', '   ');
    check('empty original falls back to catalog description', empty.includes('Read the contents of a file'));
    check('empty original still gets guidance', empty.includes('When to use:'));
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
    check('create_new_workspace known (snake alias)', getToolKnowledge('create_new_workspace')?.category === 'project');
    check('container-tools_get-config known (kebab alias)', getToolKnowledge('container-tools_get-config')?.category === 'container');
    check('unknown still undefined', getToolKnowledge('zzz_not_a_tool') === undefined);

    // Guidance is APPENDED to the real description (additive), so a real
    // description must still surface with our hints attached.
    const editFiles = augmentToolDescription('editFiles', 'Edit files');
    check('editFiles keeps real description', editFiles.startsWith('Edit files'));
    check('editFiles appends when-to-use', editFiles.includes('When to use:'));
    check('editFiles appends caution', editFiles.includes('Caution:'));

    const web = augmentToolDescription('fetch', 'Fetch page');
    check('web tool keeps real description + guidance', web.startsWith('Fetch page') && web.length > 'Fetch page'.length);

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
        'testFailure', 'test_failure', 'run_in_terminal', 'send_to_terminal',
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
        'create_new_workspace', 'container-tools_get-config',
        // Source-verified tools added v0.7.76 (reference/copilot-chat
        // package.json contributes.languageModelTools + ToolName enum).
        'execution_subagent', 'get_project_setup_info',
        'run_vscode_command', 'get_search_view_results',
    ];
    const missing = realNames.filter(n => !getToolKnowledge(n));
    check('all real bundle snake_case names present', missing.length === 0, 'missing: ' + missing.join(', '));

    // Source-verified categories for the newly added real tools.
    check('execution_subagent categorized terminal', getToolKnowledge('execution_subagent')?.category === 'terminal');
    check('get_project_setup_info categorized project', getToolKnowledge('get_project_setup_info')?.category === 'project');
    check('run_vscode_command categorized vscode', getToolKnowledge('run_vscode_command')?.category === 'vscode');
    check('get_search_view_results categorized search', getToolKnowledge('get_search_view_results')?.category === 'search');
    check('test_failure categorized diagnostics', getToolKnowledge('test_failure')?.category === 'diagnostics');

    // Enrichment works for a snake_case tool too.
    const enr = augmentToolDescription('run_in_terminal', 'Run a command');
    check('snake terminal enrichment has caution', enr.includes('Caution:'));
}

// ── 7c. Shell-adaptation guidance (Windows pwsh) ─────────────────────────
// DeepSeek defaults to bash-isms; the user's terminals run PowerShell on
// Windows. The terminal tools must tell it to adapt syntax.
console.log('\n=== 7c. Shell-adaptation guidance ===');
{
    const tSnake = augmentToolDescription('run_in_terminal', 'Run a command');
    check('run_in_terminal teaches PowerShell adaptation', /PowerShell \(pwsh\)/i.test(tSnake));
    check('run_in_terminal names bash-isms to avoid', /grep|rm -rf|export VAR/i.test(tSnake));
    check('run_in_terminal names PowerShell equivalents', /Select-String|Get-Content|Remove-Item|\$env:VAR/i.test(tSnake));

    const tCamel = augmentToolDescription('runInTerminal', 'Run a command');
    check('runInTerminal teaches PowerShell adaptation', /PowerShell \(pwsh\)/i.test(tCamel));

    const ex = augmentToolDescription('execute', 'Execute');
    check('execute teaches shell adaptation', /PowerShell \(pwsh\)/i.test(ex));

    const rc = augmentToolDescription('runCommand', 'Run a command');
    check('runCommand teaches shell adaptation', /PowerShell \(pwsh\)/i.test(rc));
}

// ── 7b. Screenshot anti-loop guidance (regression) ───────────────────────
// DeepSeek used to loop calling run_playwright_code to save a screenshot file
// (which cannot work — the snippet runs in the browser page and can't write
// files), never using screenshot_page. Assert the descriptions steer it to
// screenshot_page and forbid file saving.
console.log('\n=== 7b. Screenshot anti-loop guidance ===');
{
    const rpwSnake = augmentToolDescription('run_playwright_code', 'Run playwright');
    check('run_playwright_code warns no file writes', /CANNOT write files|require, fs, and path/i.test(rpwSnake));
    check('run_playwright_code points to screenshot_page', rpwSnake.includes('screenshot_page'));

    const rpwCamel = augmentToolDescription('runPlaywrightCode', 'Run playwright');
    check('runPlaywrightCode warns no file writes', /CANNOT write files|require, fs, and path/i.test(rpwCamel));
    check('runPlaywrightCode points to screenshot_page', rpwCamel.includes('screenshot_page'));

    const ssSnake = augmentToolDescription('screenshot_page', 'Screenshot');
    check('screenshot_page returns viewable image', /viewing|return/i.test(ssSnake));
    check('screenshot_page says no file saving needed', /No file saving|no file saving/i.test(ssSnake));
    check('screenshot_page prefer forbids save+view_image', ssSnake.includes('never try to save a screenshot file'));

    const ssCamel = augmentToolDescription('screenshotPage', 'Screenshot');
    check('screenshotPage returns viewable image', /viewing|return/i.test(ssCamel));
    check('screenshotPage says no file saving needed', /No file saving|no file saving/i.test(ssCamel));
}

// ── 8. Prefer guidance ────────────────────────────────────────────────────
console.log('\n=== 8. Prefer guidance ===');
{
    const pref = augmentToolDescription('read', 'Read');
    check('read enrichment includes Prefer guidance', pref.includes('Prefer:'));
    check('prefer advises targeted reads', pref.includes('targeted line-range reads'));
    check('edit prefer present', augmentToolDescription('edit', 'Edit').includes('Prefer targeted edits'));
    check('terminal prefer present', augmentToolDescription('runInTerminal', 'Run').includes('For test runs prefer'));
    // subagent tool descriptions carry grok-build delegation discipline.
    const runSub = augmentToolDescription('runSubagent', 'Dispatch');
    check('runSubagent prefer self unless delegating', runSub.includes('Prefer doing the work yourself unless delegation'));
    check('runSubagent prefer detailed prompt', runSub.includes('detailed, self-contained prompt'));
    const expl = augmentToolDescription('explore_subagent', 'Explore');
    check('explore_subagent read-only prefer', expl.includes('read-only'));
}

console.log(`\n===== ${safe} passed, ${failures} failed =====`);
process.exit(failures === 0 ? 0 : 1);
