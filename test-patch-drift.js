/**
 * Multi-generation drift regression test for the Copilot Chat PDF patch engine.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08 VS Code updated and renamed every minified symbol the PDF patches
 * anchored on (kkn→Fyn, RCt→Jht, VD→mB, v→_, Lu→iu, ...), breaking users who
 * updated. This test simulates that failure mode FOREVER: it builds synthetic
 * "bundle generations" — each with DIFFERENT minified symbol names — and runs
 * the EXACT production engine (out/pdf/engine.js, the same code manager.ts
 * uses) against them. If a future Copilot update renames symbols again, this
 * test is what catches it BEFORE real users hit it.
 *
 * For every generation it asserts the engine:
 *   1. DETECTS the drift-prone patches as missing (healthCheck + verify).
 *   2. SELF-HEALS by applying them (exact → regex fallback → adaptive).
 *   3. NEVER injects an identifier the bundle didn't already have (alias safety).
 *   4. Reports them applied AFTER the fix (outcome-based verification).
 *
 * Usage: node test-patch-drift.js
 * Exit code 0 = all generations self-heal; 1 = a generation would break users.
 */
'use strict';
const path = require('path');
const { buildPatches } = require('./out/pdf/patches.js');
const { healthCheck, applyMissing, introducedAliases } = require('./out/pdf/engine.js');

// The patches that are prone to minified-name drift (they got adaptive+verify).
const DRIFT_IDS = new Set(['P1', 'P2', 'P4', 'P5', 'P7', 'P8']);
const MAX_MB = 100;

// ---------------------------------------------------------------------------
// Synthetic bundle fixture builder
// ---------------------------------------------------------------------------
// `gen` picks the minified names for one hypothetical Copilot bundle
// generation. The STRUCTURE mirrors the real bundle's PDF machinery; only the
// minified identifiers differ.
function buildFixture(gen) {
    const {
        allow, preds,
        size, sizeVal,
        enumNs, lam, docNs, ep,
        vision,
        sPred = 's', lPred = 'l', cPred = 'c',
    } = gen;

    const allowBody = preds.map(p => `${p}(n)`).join('||');
    const allowDef = `function ${allow}(n){return ${allowBody}}`;

    const gateHead = vision
        ? `if(!${ep}.supportsVision||!${allow}(${ep})){`
        : `if(!${allow}(${ep})){`;
    const gate =
        `if(/\\.pdf$/i.test(o.path)){${gateHead}if(this.props.omitReferences)return;let u={status:{description:Q9.t("{0} does not support PDF documents.",${ep}.model),kind:iu.ChatResponseReferencePartStatusKind.Omitted}};return vscpp(vscppf,null,vscpp("references",{value:[new iu.PromptReference(this.props.variableName?{variableName:this.props.variableName,value:o}:o,void 0,u)]}))}}`;

    const sizeGate =
        `async function Xht(n,e,t){let r=await n.stat(e);if(r.size>${size})if(t){let o=\`[FileSystemService] \${e.toString()} is a LARGE file\`;console.warn(o)}else{let o=\`[FileSystemService] \${e.toString()} EXCEEDS max file size. FAILED to read \${Math.round(r.size/1048576)}MB > \${Math.round(${size}/1048576)}MB\`;throw new Error(o)}}`;
    const sizeDecl = `${size}=1024*1024*${sizeVal};`;

    const docCase = `if(t.type===${enumNs}.ChatCompletionContentPartKind.Document)return;`;

    const filters =
        `u=this.props.chatVariables.filter(${lam}=>${sPred}(${lam})||${lPred}(${lam})),d=this.props.chatVariables.filter(${lam}=>!${sPred}(${lam})&&!${cPred}(${lam}))`;

    const renderer = `vscpp(${docNs}.Document,{data:d,mediaType:"application/pdf"}))`;

    // Aliases the fixture "defines" so the alias-safety net sees them as
    // pre-existing (mirrors a real bundle where these module aliases exist).
    // `FA.` must appear (P5's exact replacement references FA.LanguageModelDataPart
    // on bundles where the vscode alias is FA — as in the real 0.61.0 bundle).
    const aliases = `var ${enumNs},${docNs},iu,Pre,Q9,vscpp,vscppf,t2t,Att,is;let FA=require("vscode");let q=FA.LanguageModelDataPart;`;

    return [
        'function R(n,e){return e}',
        // `n.family` must pre-exist for P1's injected deepseek check to pass
        // the alias-safety net (it does in every real bundle).
        'function fam(n){return n.family}',
        // `dd.` must pre-exist for P5's injected LanguageModelDataPart branch to
        // pass the alias-safety net (it does in every real bundle).
        'let dd=t.documentData;let x=dd.data;',
        aliases,
        allowDef,
        gate,
        sizeGate,
        sizeDecl,
        docCase,
        filters,
        renderer,
    ].join('\n');
}

const GENERATIONS = [
    {
        name: 'df53daabb1 — first verified bundle (2026-08-08)',
        allow: 'kkn', preds: ['q_', 'qj', 'j3'],
        size: 'RCt', sizeVal: 5,
        enumNs: 'VD', lam: 'v', docNs: 'Lu', ep: 'this.promptEndpoint',
        vision: true,
    },
    {
        name: 'e4c7e7b1d6 — hypothetical mid-drift (renamed symbols)',
        allow: 'lkn', preds: ['p1', 'p2', 'p3'],
        size: 'xCt', sizeVal: 5,
        enumNs: 'WA', lam: 'x', docNs: 'zz', ep: 't',
        vision: true,
    },
    {
        name: 'a5b5009513 — current 1.133.0 / Copilot 0.61.0, FRESH unpatched',
        allow: 'Fyn', preds: ['Rv', 'Lj', 't4'],
        size: 'Jht', sizeVal: 250,   // natively >= configured 100 → P2 already satisfied
        enumNs: 'mB', lam: '_', docNs: 'iu', ep: 'this.promptEndpoint',
        vision: false,               // gate already correct → P4 already satisfied
    },
    {
        name: 'extreme-drift — renamed predicates + 4-pred allowlist (forces ADAPTIVE tier)',
        allow: 'qRj', preds: ['q_', 'qj', 'j3', 'aa'],   // 4 preds: 3-pred fallback template won't match
        size: 'Zz', sizeVal: 5,
        enumNs: 'Wx', lam: 'p', docNs: 'qq', ep: 'e.model',
        vision: true,
        sPred: 'a', lPred: 'b', cPred: 'd',              // P8 preds renamed → literal-s/l fallback won't match
    },
];

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let failures = 0;
const fail = (gen, msg) => {
    failures++;
    console.log(`    ✗ FAIL: ${msg}`);
};
const ok = (msg) => console.log(`    ✓ ${msg}`);

const patches = buildPatches({ maxFileSizeMB: MAX_MB });
const byId = new Map(patches.map(p => [p.id, p]));

for (const gen of GENERATIONS) {
    console.log(`\n=== Generation: ${gen.name} ===`);
    const fixture = buildFixture(gen);

    // 0) Sanity: every drift patch must have a verify fn in this build.
    for (const id of DRIFT_IDS) {
        if (!byId.get(id)?.verify) fail(gen, `${id} missing verify() — engine can't outcome-detect it`);
    }

    // 1) Health check on the UNPATCHED fixture.
    const preHealth = healthCheck(fixture, patches);
    const preMap = new Map(preHealth.map(h => [h.id, h.applied]));
    const missingDrift = [...DRIFT_IDS].filter(id => !preMap.get(id));
    console.log(`  Pre-patch health: ${[...DRIFT_IDS].map(id => `${id}=${preMap.get(id) ? 'OK' : 'MISSING'}`).join(' ')}`);

    // Patches expected to already be satisfied natively (their verify() must
    // be true — this is the outcome-based detection working).
    for (const id of DRIFT_IDS) {
        const v = byId.get(id).verify;
        if (v && preMap.get(id) && !v(fixture)) {
            fail(gen, `${id} reported applied but verify()=false (inconsistent detection)`);
        }
    }

    // 2) Apply the missing drift-prone patches through the REAL engine.
    const missingPatches = [...DRIFT_IDS].filter(id => !preMap.get(id)).map(id => byId.get(id));
    if (missingPatches.length === 0) {
        console.log('  Nothing to apply (all drift patches natively satisfied).');
    } else {
        const outcome = applyMissing(fixture, missingPatches);
        const failed = outcome.failedIds;
        if (failed.length > 0) {
            fail(gen, `engine could NOT self-heal: failed ${failed.join(', ')} — ${outcome.failedReasons[failed[0]]}`);
        } else {
            ok(`engine applied ${outcome.appliedIds.join(', ')} on a drifted bundle`);
        }

        // 3) Alias safety: the patched bundle must not reference identifiers
        //    the original never had (would crash at runtime).
        const bad = introducedAliases(fixture, outcome.content);
        if (bad.length > 0) fail(gen, `alias-safety violated: injected ${bad.join(', ')}`);
        else ok('alias-safety: no unknown identifiers injected');

        // 4) Post-patch health: every drift patch must now be applied.
        const postHealth = healthCheck(outcome.content, patches);
        const postMap = new Map(postHealth.map(h => [h.id, h.applied]));
        const stillMissing = [...DRIFT_IDS].filter(id => !postMap.get(id));
        if (stillMissing.length > 0) fail(gen, `still missing after apply: ${stillMissing.join(', ')}`);
        else ok('post-patch health: all drift patches applied');

        // 5) Outcome-based verify must agree with post health.
        for (const id of DRIFT_IDS) {
            const v = byId.get(id).verify(outcome.content);
            if (!v && postMap.get(id)) fail(gen, `${id} applied but verify()=false`);
            if (v && !postMap.get(id)) fail(gen, `${id} verify()=true but health says missing`);
        }

        // 6) Functional outcome strings are actually present.
        const checks = {
            P1: () => outcome.content.includes('startsWith("deepseek")'),
            P2: () => new RegExp(`${gen.size}=1024\\*1024\\*${MAX_MB};`).test(outcome.content),
            P4: () => !outcome.content.includes('supportsVision'),
            P5: () => outcome.content.includes('LanguageModelDataPart'),
            P8: () => byId.get('P8').verify(outcome.content),
        };
        for (const [id, check] of Object.entries(checks)) {
            if (!preMap.get(id) && !check()) fail(gen, `${id} applied but functional outcome absent`);
        }
        if (![...Object.entries(checks)].some(([, c]) => !c())) ok('functional outcomes present');
    }

    // 7) DIRECT adaptive-tier unit check: each adaptive rule must locate its
    //    stable anchor, extract the REAL minified names, and rebuild a valid
    //    find/replace (find must be a unique substring of the fixture).
    for (const id of DRIFT_IDS) {
        const p = byId.get(id);
        if (!p.adaptive) continue;
        const re = new RegExp(p.adaptive.pattern.source, p.adaptive.pattern.flags);
        const m = re.exec(fixture);
        if (!m) {
            if (!preMap.get(id)) fail(gen, `${id} adaptive anchor not found in fixture`);
            continue;
        }
        const built = p.adaptive.build(m, fixture);
        if (built === undefined) {
            // build() may legitimately decline when the region is already in
            // the desired state (e.g. P2/P4 on gen3 where verify is already true).
            if (!preMap.get(id)) fail(gen, `${id} adaptive build() returned undefined on an unpatched fixture`);
            continue;
        }
        const count = fixture.split(built.find).length - 1;
        if (count !== 1) fail(gen, `${id} adaptive find not unique (count=${count})`);
        else if (built.replace === built.find) fail(gen, `${id} adaptive replace identical to find`);
        else ok(`${id} adaptive rule → extracted real names, rebuilt valid find/replace`);
    }
}

console.log('\n----------------------------------------');
if (failures === 0) {
    console.log(`✅ PASS — all ${GENERATIONS.length} bundle generations self-healed (engine is drift-proof).`);
    process.exit(0);
} else {
    console.log(`❌ FAIL — ${failures} assertion(s) failed. A future Copilot rename would break users.`);
    process.exit(1);
}
