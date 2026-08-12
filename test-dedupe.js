// Mirror tests for the duplicate internal-request suppression (provider.ts:
// dedupFingerprint / dedupEligible / beginDedup). Excluded from the vsix via
// .vscodeignore.
//
// Background: VS Code/Copilot fires the SAME tiny internal helper request
// twice ~8ms apart at session start (identical "Sending ..." pairs in
// nikas.log, e.g. tools=0, ~2KB). The provider now detects the duplicate
// (identical serialized request, tools=0, tiny body, in flight within a short
// window) and REPLAYS the first response instead of making a second DeepSeek
// call.

let checks = 0, fails = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('  FAIL', msg); } else console.log('  PASS', msg); };
const eq = (a, b, msg) => { checks++; if (a !== b) { fails++; console.log('  FAIL', msg, `(got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); } else console.log('  PASS', msg); };

// ── mirrored implementation (injectable clock) ──
let clock = 1000;
const DEDUP_WINDOW_MS = 2000;
const DEDUP_MAX_BODY_BYTES = 4096;

function dedupFingerprint(request) {
    let h = 0x811c9dc5;
    const s = JSON.stringify(request);
    for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 0x01000193;
    return (h >>> 0).toString(16);
}
function dedupEligible(toolsCount, bodyBytes) {
    return toolsCount === 0 && bodyBytes > 0 && bodyBytes <= DEDUP_MAX_BODY_BYTES;
}
const dedupRuns = new Map();
async function beginDedup(key, bodyBytes, progress) {
    if (!key) return { outcome: 'primary', settle: () => {} };
    const now = clock;
    const existing = dedupRuns.get(key);
    if (existing && existing.bodyBytes === bodyBytes && now - existing.startedAt <= DEDUP_WINDOW_MS) {
        if (!existing.done) await existing.promise;
        for (const part of existing.parts) progress.report(part);
        return { outcome: 'duplicate' };
    }
    dedupRuns.delete(key);
    for (const [k, r] of dedupRuns) if (now - r.startedAt > DEDUP_WINDOW_MS) dedupRuns.delete(k);
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    const captured = [];
    const run = { startedAt: now, bodyBytes, parts: captured, promise, done: false };
    dedupRuns.set(key, run);
    const originalReport = progress.report.bind(progress);
    progress.report = (part) => { captured.push(part); originalReport(part); };
    return { outcome: 'primary', settle: () => { run.done = true; resolve(); } };
}

// ── 1. eligibility ──
function sectionEligible() {
    ok(dedupEligible(0, 2200) === true, '1a tools=0 tiny body eligible');
    ok(dedupEligible(51, 2200) === false, '1b tools>0 never eligible');
    ok(dedupEligible(0, 0) === false, '1c empty body not eligible');
    ok(dedupEligible(0, 4096) === true, '1d boundary 4096 eligible');
    ok(dedupEligible(0, 4097) === false, '1e above 4096 not eligible');
}

// ── 2. fingerprint ──
function sectionFingerprint() {
    const a = dedupFingerprint({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] });
    const b = dedupFingerprint({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] });
    const c = dedupFingerprint({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'bye' }] });
    eq(a, b, '2a identical request → identical fingerprint');
    ok(a !== c, '2b different content → different fingerprint');
    ok(/^[0-9a-f]+$/.test(a), '2c fingerprint is hex');
}

// ── 3. duplicate detection + replay ──
function makeProgress() { return { parts: [], report(p) { this.parts.push(p); } }; }

async function sectionDedup() {
    // 3a: first request → primary, subsequent reports get captured.
    const p1 = makeProgress();
    const r1 = await beginDedup('k1', 2200, p1);
    eq(r1.outcome, 'primary', '3a first request is primary');
    p1.report({ kind: 'text', value: 'hello' });
    p1.report({ kind: 'data', mime: 'usage' });
    eq(p1.parts.length, 2, '3a original progress still receives parts');

    // 3b: identical second request in flight → duplicate awaits the primary,
    // then replays captured parts once the primary settles.
    const p2 = makeProgress();
    const pending2 = beginDedup('k1', 2200, p2);
    r1.settle(); // primary completes → releases the waiting duplicate
    const r2 = await pending2;
    eq(r2.outcome, 'duplicate', '3b duplicate within window');
    eq(p2.parts.length, 2, '3b replayed all captured parts');
    eq(p2.parts[0].value, 'hello', '3b replay content matches');

    // 3c: after settle, a later duplicate still replays.
    r1.settle();
    const p3 = makeProgress();
    const r3 = await beginDedup('k1', 2200, p3);
    eq(r3.outcome, 'duplicate', '3c duplicate after settle still replays');
    eq(p3.parts.length, 2, '3c replay count after settle');

    // 3d: same key but different bodyBytes → NOT a duplicate (collision guard).
    const p3b = makeProgress();
    const r3b = await beginDedup('k1', 2201, p3b);
    eq(r3b.outcome, 'primary', '3d same key different bodyBytes → primary (collision guard)');

    // 3e: different key → independent, no cross-replay.
    const p4 = makeProgress();
    const r4 = await beginDedup('k2', 1800, p4);
    eq(r4.outcome, 'primary', '3e different key → primary');
    p4.report({ kind: 'text', value: 'other' });
    const p5 = makeProgress();
    const pending5 = beginDedup('k2', 1800, p5);
    r4.settle(); // release the waiting duplicate
    const r5 = await pending5;
    eq(r5.outcome, 'duplicate', '3e k2 duplicate replays own parts');
    eq(p5.parts[0].value, 'other', '3e no cross-session bleed');

    // 3f: window expiry → same key becomes primary again (no stale replay).
    r4.settle();
    clock += DEDUP_WINDOW_MS + 1;
    const p6 = makeProgress();
    const r6 = await beginDedup('k2', 1800, p6);
    eq(r6.outcome, 'primary', '3f expired window → primary again');

    // 3g: no key (handler gate: tools>0 or oversized body) → always primary.
    const p7 = makeProgress();
    const r7 = await beginDedup(undefined, 2200, p7);
    eq(r7.outcome, 'primary', '3g no key → always primary');
    const gate = (tools, bytes, req) => dedupEligible(tools, bytes) ? dedupFingerprint(req) : undefined;
    ok(gate(51, 2000, { x: 1 }) === undefined, '3g tools>0 → no key → never deduped');
    ok(gate(0, 9000, { x: 1 }) === undefined, '3g oversized body → no key → never deduped');
    ok(gate(0, 2000, { x: 1 }) !== undefined, '3g tools=0 tiny → key present → dedupe applies');
}

async function main() {
    sectionEligible();
    sectionFingerprint();
    await sectionDedup();
    console.log(`${checks} checks, ${fails} fail`);
    if (fails > 0) process.exit(1);
}
main();
