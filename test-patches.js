/**
 * Standalone test for the Copilot Chat PDF patch definitions.
 * Reads the real bundle, applies missing patches to a TEMP COPY, verifies.
 * Does NOT touch the real bundle. Uses the SAME production engine as the
 * extension (out/pdf/engine.js), so the test exercises the exact runtime path.
 */
const fs = require('fs');
const path = require('path');
const { buildPatches } = require('./out/pdf/patches.js');
const { healthCheck, applyMissing } = require('./out/pdf/engine.js');

const bundlePath = process.argv[2];
if (!bundlePath || !fs.existsSync(bundlePath)) {
    console.error('Usage: node test-patches.js <path-to-extension.js> [maxFileSizeMB]');
    process.exit(1);
}

// Mirror the runtime: the patcher uses the user's nikas.copilotMaxFileSizeMB
// (default 100). Accept an optional arg so tests can match the real setting.
const maxMB = parseInt(process.argv[3] || '100', 10);
const patches = buildPatches({ maxFileSizeMB: maxMB });
const content = fs.readFileSync(bundlePath, 'utf-8');

console.log('Patch health on real bundle:');
const pre = healthCheck(content, patches);
const missing = pre.filter(h => !h.applied);
for (const h of pre) {
    console.log(`  ${h.applied ? 'OK     ' : 'MISSING'} ${h.id} — ${h.description}`);
}
console.log(`\nMissing: ${missing.length}`);

if (missing.length === 0) {
    console.log('Nothing to apply.');
    process.exit(0);
}

// Apply through the production engine to a TEMP COPY.
const missingDefs = missing.map(h => patches.find(p => p.id === h.id));
const outcome = applyMissing(content, missingDefs);
const { content: working, appliedIds, failedIds } = outcome;

const tmp = path.join(process.cwd(), 'extension.patched.test.js');
fs.writeFileSync(tmp, working);
console.log(`\nWrote patched copy to ${tmp}`);
for (const id of appliedIds) console.log(`  APPLIED  ${id}`);
for (const id of failedIds) console.log(`  FAILED   ${id}`);

// Verify with the same engine.
const verify = fs.readFileSync(tmp, 'utf-8');
const post = healthCheck(verify, patches);
const stillMissing = post.filter(h => !h.applied);
console.log(`\nVerify: ${stillMissing.length} still missing (before: ${missing.length})`);
console.log(`Applied: [${appliedIds.join(', ')}]  Failed: [${failedIds.join(', ')}]`);

// Basic sanity: patched copy should still be parseable by node (syntax check)
try {
    new Function(verify);
    console.log('Syntax sanity (full file): OK');
} catch (e) {
    console.log('Syntax sanity: FAILED —', e.message);
}

fs.unlinkSync(tmp);
console.log('Temp file removed.');
