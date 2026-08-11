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

console.log(`\n===== ${safe} passed, ${failures} failed =====`);
process.exit(failures === 0 ? 0 : 1);
