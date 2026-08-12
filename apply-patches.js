/**
 * One-shot apply of the Copilot Chat PDF patches to the REAL bundle
 * (with backup + verify). Uses the SAME production engine as the extension
 * (out/pdf/engine.js — healthCheck + applyMissing + alias-safety net), so the
 * CLI and the runtime can never drift apart.
 *
 * Usage: node apply-patches.js <path-to-extension.js> [maxFileSizeMB]
 */
const fs = require('fs');
const path = require('path');
const { buildPatches } = require('./out/pdf/patches.js');
const { healthCheck, applyMissing } = require('./out/pdf/engine.js');

const bundlePath = process.argv[2];
const maxMB = parseInt(process.argv[3] || '100', 10);
if (!bundlePath || !fs.existsSync(bundlePath)) {
    console.error('Usage: node apply-patches.js <path-to-extension.js> [maxFileSizeMB]');
    process.exit(1);
}

const patches = buildPatches({ maxFileSizeMB: maxMB });
const content = fs.readFileSync(bundlePath, 'utf-8');

const missing = healthCheck(content, patches).filter(h => !h.applied);
console.log(`Missing: ${missing.length} of ${patches.length}`);
if (missing.length === 0) {
    console.log('All patches already applied — nothing to do.');
    process.exit(0);
}

// Backup
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..+/, '');
const backup = `${bundlePath}.bak-${stamp}`;
fs.copyFileSync(bundlePath, backup);
console.log(`Backup → ${backup}`);

// Apply through the production engine (exact → regex fallback → adaptive,
// with the alias-safety net refusing injections that would crash at runtime).
const missingDefs = missing.map(h => patches.find(p => p.id === h.id));
const outcome = applyMissing(content, missingDefs);
const { content: patched, appliedIds, failedIds } = outcome;

if (patched !== content) {
    fs.writeFileSync(bundlePath, patched, 'utf-8');
    console.log(`Wrote ${bundlePath}`);
} else {
    console.log('No changes produced (nothing matched).');
}

// Verify with the same engine.
const verify = fs.readFileSync(bundlePath, 'utf-8');
const stillMissing = healthCheck(verify, patches).filter(h => !h.applied);
console.log(`Verify: ${stillMissing.length} still missing. Applied=[${appliedIds.join(',')}] Failed=[${failedIds.join(',')}]`);
if (stillMissing.length === 0) console.log('✅ All Copilot Chat PDF patches applied. Reload VS Code to activate.');
else process.exit(2);
