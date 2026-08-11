// Tests the repository AGENTS.md manager (src/agentInstructions.ts) that forces
// Nikas' pro-SWE guide onto Copilot's native agent-instruction mechanism.
// Run: node test-agent-instructions.js
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Mock the vscode module before loading anything that imports it ───────
const Module = require('module');
const originalLoad = Module._load;
const vscodeMock = {
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => false }) },
    WorkspaceFolder: function () {},
    lm: { registerLanguageModelChatProvider() {} },
};
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeMock;
    return originalLoad.apply(this, arguments);
};

const {
    buildAgentInstructionsContent,
    applyAgentInstructions,
    restoreAgentInstructions,
    syncAgentInstructions,
} = require('./out/agentInstructions.js');

// Mock getAgentInstructions through config: config reads from getConfig() which
// uses vscode.workspace.getConfiguration. We override the setting value by
// swapping the mock's getConfiguration before each sync test.
function setSetting(value) {
    vscodeMock.workspace.getConfiguration = () => ({
        get: () => value,
    });
}
setSetting(false);

let safe = 0;
let failures = 0;
function check(name, cond, detail) {
    if (cond) { safe++; console.log(`  PASS ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

const header = '<!-- nikas:managed - do not edit manually -->';
const suffix = '.nikas-backup';

// ── 1. Content builder ───────────────────────────────────────────────────
console.log('\n=== 1. buildAgentInstructionsContent ===');
{
    const content = buildAgentInstructionsContent();
    check('has managed marker header', content.startsWith(header));
    check('mentions operating discipline', content.includes('Operating discipline'));
    check('mentions pro-SWE workflow', content.includes('pro-SWE'));
    check('includes understand step', content.includes('Understand'));
    check('includes reflect step', content.includes('Reflect'));
    check('mentions test discipline', content.includes('Test'));
}

function folderFor(dir) { return { uri: { fsPath: dir } }; }

// ── 2. applyAgentInstructions to a temp dir (async) ──────────────────────
let tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nikas-ai-'));
let agentsPath = path.join(tmp, 'AGENTS.md');

(async () => {
    console.log('\n=== 2. apply (async) ===');
    {
        const ok = await applyAgentInstructions(folderFor(tmp));
        check('returns true', ok === true);
        check('wrote AGENTS.md', fs.existsSync(agentsPath));
        const content = fs.readFileSync(agentsPath, 'utf8');
        check('written file is managed (has marker)', content.startsWith(header));
        // Idempotent: second apply does not overwrite user content / stays same
        const before = fs.readFileSync(agentsPath, 'utf8');
        await applyAgentInstructions(folderFor(tmp));
        const after = fs.readFileSync(agentsPath, 'utf8');
        check('idempotent (no churn)', before === after);
    }

    console.log('\n=== 3. restore removes managed file ===');
    {
        const ok = await restoreAgentInstructions(folderFor(tmp));
        check('returns true', ok === true);
        check('removed AGENTS.md', !fs.existsSync(agentsPath));
    }

    console.log('\n=== 4. backup + restore of pre-existing file ===');
    let tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nikas-ai2-'));
    let agentsPath2 = path.join(tmp2, 'AGENTS.md');
    {
        const original = '# my hand-authored instructions\n\ndo not clobber me\n';
        fs.writeFileSync(agentsPath2, original, 'utf8');

        const ok = await applyAgentInstructions(folderFor(tmp2));
        check('apply true', ok === true);
        check('backup exists', fs.existsSync(agentsPath2 + suffix));
        check('backup holds original', fs.readFileSync(agentsPath2 + suffix, 'utf8') === original);
        check('AGENTS.md now managed', fs.readFileSync(agentsPath2, 'utf8').startsWith(header));

        // Restore should bring back the original
        const restored = await restoreAgentInstructions(folderFor(tmp2));
        check('restore true', restored === true);
        check('original content restored', fs.readFileSync(agentsPath2, 'utf8') === original);
        check('backup cleaned up', !fs.existsSync(agentsPath2 + suffix));
    }

    console.log('\n=== 5. user-managed (unmanaged) file is left alone ===');
    {
        const content = '# plain file, no marker\n';
        fs.writeFileSync(agentsPath2, content, 'utf8');
        const ok = await restoreAgentInstructions(folderFor(tmp2));
        check('restore true', ok === true);
        check('unmanaged file untouched', fs.readFileSync(agentsPath2, 'utf8') === content);
    }

    console.log('\n=== 6. sync honors the setting ===');
    let tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'nikas-ai3-'));
    let agentsPath3 = path.join(tmp3, 'AGENTS.md');
    {
        setSetting(true);
        await syncAgentInstructions(folderFor(tmp3));
        check('enabled → AGENTS.md managed', fs.existsSync(agentsPath3) && fs.readFileSync(agentsPath3, 'utf8').startsWith(header));

        setSetting(false);
        await syncAgentInstructions(folderFor(tmp3));
        check('disabled → AGENTS.md removed', !fs.existsSync(agentsPath3));
    }

    console.log('\n=== 7. no folder is a no-op (no throw) ===');
    {
        setSetting(true);
        const ok = await syncAgentInstructions(undefined);
        check('sync with no folder resolves', ok === undefined || ok === false);
    }

    // Cleanup temp dirs
    for (const d of [tmp, tmp2, tmp3]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

    console.log(`\nResult: ${safe} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
})();
