/**
 * REAL-bundle drift simulation test.
 *
 * Takes the ACTUAL installed Copilot bundle and REVERTS the five drift-prone
 * patches (P1/P2/P4/P5/P8) back to their UNPATCHED forms — exactly what a
 * fresh Copilot Chat update ships — then runs the production engine and
 * asserts it re-applies all of them with valid syntax and no unsafe aliases.
 *
 * This is the closest possible proof that a future Copilot update (which
 * reverts our patches and may rename symbols) will be self-healed for ALL
 * users, not just on synthetic fixtures.
 *
 * Usage: node test-patch-real-drift.js <path-to-extension.js> [maxFileSizeMB]
 */
'use strict';
const fs = require('fs');
const { buildPatches } = require('./out/pdf/patches.js');
const { healthCheck, applyMissing, introducedAliases } = require('./out/pdf/engine.js');

const bundlePath = process.argv[2];
const maxMB = parseInt(process.argv[3] || '100', 10);
if (!bundlePath || !fs.existsSync(bundlePath)) {
    console.error('Usage: node test-patch-real-drift.js <path-to-extension.js> [maxFileSizeMB]');
    process.exit(1);
}

let failures = 0;
const fail = (m) => { failures++; console.log(`  ✗ FAIL: ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

const patches = buildPatches({ maxFileSizeMB: maxMB });
const byId = new Map(patches.map(p => [p.id, p]));
const content = fs.readFileSync(bundlePath, 'utf-8');

// ---- 1) Sanity: the real bundle must currently be fully patched. ----
const pre = healthCheck(content, patches);
const preMissing = pre.filter(h => !h.applied).map(h => h.id);
if (preMissing.length > 0) {
    console.log(`Real bundle is NOT fully patched (${preMissing.join(', ')} missing) — aborting; run apply first.`);
    process.exit(1);
}
console.log('Real bundle: all 10 patches applied (baseline OK).');

// ---- 2) Revert the 5 drift-prone patches to their UNPATCHED forms. ----
// P1: remove the deepseek clause from the allowlist fn.
// P4: re-add the supportsVision requirement to the PDF gate.
// P5: restore the bare `return;` Document case.
// P8: drop the binary `c` predicate from the forwarded filter.
// P2: restore the 5 MB cap (only if the current value differs from 5).
let reverted = content;

// P1 — find `function <name>(n){return <body>||(n.family||"").startsWith("deepseek")}`
// and strip the deepseek OR-clause.
reverted = reverted.replace(
    /(function ([\w$]{1,3})\(n\)\{return [^}]*?)\|\|\(n\.family\|\|""\)\.startsWith\("deepseek"\)(\})/,
    (_m, head, _fn, tail) => head + tail
);

// P4 — re-add supportsVision to the PDF gate (`if(!<fn>(<ep>)){` → `if(!<ep>.supportsVision||!<fn>(<ep>)){`)
// where the gate is followed by the omitReferences branch. (The error string is
// followed by `,<ep>.model)` — we stop the regex at the closing quote.)
reverted = reverted.replace(
    /(if\(!([\w$]{1,3})\(([\w$]+(?:\.[\w$]+)*)\)\)\{if\(this\.props\.omitReferences\)return;let u=\{status:\{description:Q9\.t\("\{0\} does not support PDF documents\.")/,
    (_m, _gate, fn, ep) => `if(!${ep}.supportsVision||!${fn}(${ep})){if(this.props.omitReferences)return;let u={status:{description:Q9.t("{0} does not support PDF documents."`
);

// P5 — restore bare `return;` Document case in the OpenAI-mode converter.
reverted = reverted.replace(
    /if\(t\.type===(\w{1,3})\.ChatCompletionContentPartKind\.Document\)\{let dd=t\.documentData,db=typeof dd\.data=="string"\?Buffer\.from\(dd\.data,"base64"\):Buffer\.from\(dd\.data\);return new (?:[A-Za-z_$][\w$]*\.|\(require\("vscode"\)\.)LanguageModelDataPart\)\(new Uint8Array\(db\),dd\.mediaType\|\|"application\/pdf"\)\}/,
    (_m, ns) => `if(t.type===${ns}.ChatCompletionContentPartKind.Document)return;`
);

// P8 — drop the binary `c` predicate from the forwarded filter (three-OR → two-OR).
// Matches the three-OR filter and removes ONLY the middle `||<pred>(<param>)` term.
reverted = reverted.replace(
    /(u=this\.props\.chatVariables\.filter\(([\w$])=>([\w$]+)\(\2\))(\|\|[\w$]+\(\2\))(\|\|[\w$]+\(\2\)\),d=this\.props\.chatVariables\.filter)/,
    (_m, head, _p, _s, mid, tail) => head + tail
);

// P2 — reset the size const to 5 MB (`<name>=1024*1024*N;` → `N` = 5).
reverted = reverted.replace(/([\w$]{2,3}=1024\*1024\*)\d+;/, '$15;');

const drift = ['P1', 'P2', 'P4', 'P5', 'P8'].filter(id => byId.get(id).verify(reverted) === false);
console.log(`Reverted to unpatched state; drift-prone patches now unsatisfied: ${drift.join(', ')}`);
if (drift.length !== 5) fail(`expected all 5 reverted, got: ${drift.join(', ')}`);
else ok('all 5 patches reverted to their unpatched forms');

// ---- 3) Run the production engine on the REVERTED REAL bundle. ----
const missing = healthCheck(reverted, patches).filter(h => !h.applied).map(h => h.id);
const missingDefs = missing.map(id => byId.get(id));
const outcome = applyMissing(reverted, missingDefs);

if (outcome.failedIds.length > 0) fail(`engine failed to re-apply: ${outcome.failedIds.join(', ')}`);
else ok(`engine re-applied: ${outcome.appliedIds.join(', ')}`);

// ---- 4) Alias safety on the full real bundle. ----
const bad = introducedAliases(reverted, outcome.content);
if (bad.length > 0) fail(`alias-safety violated: ${bad.join(', ')}`);
else ok('alias-safety: no unknown identifiers injected into the real bundle');

// ---- 5) Post-patch health must be all-applied. ----
const post = healthCheck(outcome.content, patches);
const postMissing = post.filter(h => !h.applied).map(h => h.id);
if (postMissing.length > 0) fail(`still missing after re-apply: ${postMissing.join(', ')}`);
else ok('post-patch health: all 10 patches applied');

// ---- 6) Syntax sanity on the full re-patched real bundle. ----
try {
    new Function(outcome.content);
    ok('syntax sanity (full 19MB bundle): OK');
} catch (e) {
    fail(`syntax sanity: FAILED — ${e.message.slice(0, 200)}`);
}

console.log('\n----------------------------------------');
if (failures === 0) {
    console.log('✅ PASS — the engine re-heals the REAL bundle after a simulated update reset.');
    process.exit(0);
} else {
    console.log(`❌ FAIL — ${failures} assertion(s) failed.`);
    process.exit(1);
}
