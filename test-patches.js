/**
 * Standalone test for the Copilot Chat PDF patch definitions.
 * Reads the real bundle, applies missing patches to a TEMP COPY, verifies.
 * Does NOT touch the real bundle.
 */
const fs = require('fs');
const path = require('path');
const { buildPatches } = require('./out/pdf/patches.js');

const bundlePath = process.argv[2];
if (!bundlePath || !fs.existsSync(bundlePath)) {
    console.error('Usage: node test-patches.js <path-to-extension.js>');
    process.exit(1);
}

const patches = buildPatches({ maxFileSizeMB: 100 });
const content = fs.readFileSync(bundlePath, 'utf-8');

console.log('Patch health on real bundle:');
const missing = [];
for (const p of patches) {
    const applied = p.appliedMarkers.some(m => content.includes(m));
    console.log(`  ${applied ? 'OK     ' : 'MISSING'} ${p.id} — ${p.description}`);
    if (!applied) missing.push(p);
}
console.log(`\nMissing: ${missing.length}`);

if (missing.length === 0) {
    console.log('Nothing to apply.');
    process.exit(0);
}

// Apply to a temp copy
let working = content;
const appliedIds = [];
const failed = [];
for (const p of missing) {
    let success = false;
    for (const r of p.replacements) {
        if (working.includes(r.find)) {
            working = working.replace(r.find, r.replace);
            success = true;
            break;
        }
    }
    if (!success) {
        for (const fb of p.regexFallbacks || []) {
            const re = new RegExp(fb.pattern.source, fb.pattern.flags);
            if (re.test(working)) {
                const replaced = typeof fb.replacement === 'function'
                    ? working.replace(re, fb.replacement)
                    : working.replace(re, fb.replacement);
                if (replaced !== working) {
                    working = replaced;
                    success = true;
                    break;
                }
            }
        }
    }
    if (success) {
        appliedIds.push(p.id);
        console.log(`  APPLIED  ${p.id}`);
    } else {
        failed.push(p.id);
        console.log(`  FAILED   ${p.id} — no matching find`);
    }
}

const tmp = path.join(process.cwd(), 'extension.patched.test.js');
fs.writeFileSync(tmp, working);
console.log(`\nWrote patched copy to ${tmp}`);

// Verify
const verify = fs.readFileSync(tmp, 'utf-8');
let stillMissing = 0;
for (const p of patches) {
    if (!p.appliedMarkers.some(m => verify.includes(m))) {
        stillMissing++;
        console.log(`  STILL MISSING ${p.id}`);
    }
}
console.log(`\nVerify: ${stillMissing} still missing (before: ${missing.length})`);
console.log(`Applied: [${appliedIds.join(', ')}]  Failed: [${failed.join(', ')}]`);

// Basic sanity: patched copy should still be parseable by node (syntax check)
try {
    new Function(verify);
    console.log('Syntax sanity (full file): OK');
} catch (e) {
    console.log('Syntax sanity: FAILED —', e.message);
}

fs.unlinkSync(tmp);
console.log('Temp file removed.');
