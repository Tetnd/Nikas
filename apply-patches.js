/**
 * One-shot apply of the Copilot Chat PDF patches to the REAL bundle
 * (with backup + verify). Mirrors src/pdf/manager.ts logic.
 *
 * Usage: node apply-patches.js <path-to-extension.js> [maxFileSizeMB]
 */
const fs = require('fs');
const path = require('path');
const { buildPatches } = require('./out/pdf/patches.js');

const bundlePath = process.argv[2];
const maxMB = parseInt(process.argv[3] || '100', 10);
if (!bundlePath || !fs.existsSync(bundlePath)) {
    console.error('Usage: node apply-patches.js <path-to-extension.js> [maxFileSizeMB]');
    process.exit(1);
}

const patches = buildPatches({ maxFileSizeMB: maxMB });
const content = fs.readFileSync(bundlePath, 'utf-8');

const missing = patches.filter(p => !p.appliedMarkers.some(m => content.includes(m)));
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

// Apply
let working = content;
const appliedIds = [];
const failed = [];
for (const p of missing) {
    let success = false;
    for (const r of p.replacements) {
        if (working.includes(r.find)) { working = working.replace(r.find, r.replace); success = true; break; }
    }
    if (!success) {
        for (const fb of p.regexFallbacks || []) {
            const re = new RegExp(fb.pattern.source, fb.pattern.flags);
            if (re.test(working)) {
                const replaced = typeof fb.replacement === 'function'
                    ? working.replace(re, fb.replacement)
                    : working.replace(re, fb.replacement);
                if (replaced !== working) { working = replaced; success = true; break; }
            }
        }
    }
    if (success) { appliedIds.push(p.id); console.log(`  APPLIED ${p.id}`); }
    else { failed.push(p.id); console.log(`  FAILED  ${p.id}`); }
}

fs.writeFileSync(bundlePath, working, 'utf-8');
console.log(`Wrote ${bundlePath}`);

// Verify
const verify = fs.readFileSync(bundlePath, 'utf-8');
const stillMissing = patches.filter(p => !p.appliedMarkers.some(m => verify.includes(m)));
console.log(`Verify: ${stillMissing.length} still missing. Applied=[${appliedIds.join(',')}] Failed=[${failed.join(',')}]`);
if (stillMissing.length === 0) console.log('✅ All Copilot Chat PDF patches applied. Reload VS Code to activate.');
else process.exit(2);
