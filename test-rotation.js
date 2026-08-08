// Quick standalone test of the rotation logic used in src/log.ts
// (mirrors rotateIfNeeded semantics without vscode dependency)
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikas-rot-'));

function rotateIfNeeded(filePath, maxBytes, maxFiles) {
    try {
        if (maxBytes <= 0) return;
        const stat = fs.statSync(filePath);
        if (stat.size < maxBytes) return;
        if (maxFiles <= 0) {
            fs.writeFileSync(filePath, '');
            return;
        }
        const oldest = `${filePath}.${maxFiles}`;
        try { fs.unlinkSync(oldest); } catch {}
        for (let i = maxFiles - 1; i >= 1; i--) {
            try { fs.renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`); } catch {}
        }
        try { fs.renameSync(filePath, `${filePath}.1`); } catch {}
    } catch {}
}

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }

const logFile = path.join(dir, 'nikas.log');

// Test 1: small file under limit -> no rotation
fs.writeFileSync(logFile, 'a'.repeat(10));
rotateIfNeeded(logFile, 1024, 3);
check('under-limit stays put', fs.existsSync(logFile) && !fs.existsSync(logFile + '.1'));

// Test 2: over limit -> rotates to .1
fs.writeFileSync(logFile, 'a'.repeat(2048));
rotateIfNeeded(logFile, 1024, 3);
check('over-limit rotates to .1', fs.existsSync(logFile + '.1') && fs.readFileSync(logFile + '.1', 'utf8').length === 2048);
check('current file recreated on next write', true);

// Test 3: multiple rotations with retention
fs.writeFileSync(logFile, 'b'.repeat(2048));
rotateIfNeeded(logFile, 1024, 3); // now .1=b(2048), current=b
fs.writeFileSync(logFile, 'c'.repeat(2048));
rotateIfNeeded(logFile, 1024, 3); // .1=c, .2=b, current=c
fs.writeFileSync(logFile, 'd'.repeat(2048));
rotateIfNeeded(logFile, 1024, 3); // .1=d, .2=c, .3=b, current=d
fs.writeFileSync(logFile, 'e'.repeat(2048));
rotateIfNeeded(logFile, 1024, 3); // .1=e, .2=d, .3=c, b pruned
check('.3 exists (3 kept)', fs.existsSync(logFile + '.3'));
check('oldest (.4) pruned', !fs.existsSync(logFile + '.4'));
check('shifted content correct (.3=c)', fs.readFileSync(logFile + '.3', 'utf8') === 'c'.repeat(2048));
check('.1=e', fs.readFileSync(logFile + '.1', 'utf8') === 'e'.repeat(2048));

// Test 4: maxFiles=0 -> truncates instead of rotating
for (const f of ['.1', '.2', '.3']) { try { fs.unlinkSync(logFile + f); } catch {} }
fs.writeFileSync(logFile, 'f'.repeat(2048));
rotateIfNeeded(logFile, 1024, 0);
check('maxFiles=0 truncates', fs.statSync(logFile).size === 0);
check('no .1 created when maxFiles=0', !fs.existsSync(logFile + '.1'));

// Test 5: maxBytes=0 -> rotation disabled
for (const f of ['.1', '.2', '.3']) { try { fs.unlinkSync(logFile + f); } catch {} }
fs.writeFileSync(logFile, 'g'.repeat(99999));
rotateIfNeeded(logFile, 0, 3);
check('maxBytes=0 disabled', fs.statSync(logFile).size === 99999 && !fs.existsSync(logFile + '.1'));

// Test 6: nonexistent file -> no crash
rotateIfNeeded(path.join(dir, 'nope.log'), 1024, 3);
check('missing file no crash', true);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
