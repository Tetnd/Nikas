// test-usage.js — unit tests for the Usage & Cost tracker (src/usage/tracker.ts),
// v0.7.78. The module is vscode-free by design, so we test the compiled output
// directly with plain node.
//
// Covers: aggregation (total / byProvider / bySession), pricing math, the
// bounded recents + per-session caps with LRU eviction, hydrate() round-trip,
// formatTokens / formatCost, the enabled flag, and the "record() never throws"
// guarantee that keeps the request path safe.

const { UsageTracker, formatTokens, formatCost, formatLatency, setUsageTrackingEnabled, isUsageTrackingEnabled } =
    require('./out/usage/tracker.js');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
    if (cond) { passed++; }
    else { failed++; failures.push(name); console.error('  FAIL: ' + name); }
}

function approx(a, b, eps = 1e-9) {
    return Math.abs(a - b) <= eps;
}

// ── 1. format helpers ──
assert(formatTokens(0) === '0', 'formatTokens(0)');
assert(formatTokens(123) === '123', 'formatTokens(123)');
assert(formatTokens(12300) === '12.3k', 'formatTokens(12300)');
assert(formatTokens(999999) === '1000.0k', 'formatTokens(999999) rounds to k');
assert(formatTokens(1200000) === '1.2M', 'formatTokens(1200000)');
assert(formatTokens(1234567890) === '1234.6M', 'formatTokens(1234567890)');
assert(formatCost(0) === '$0.0000', 'formatCost(0)');
assert(formatCost(0.0042) === '$0.0042', 'formatCost(0.0042)');
assert(formatCost(1.23) === '$1.23', 'formatCost(1.23)');
assert(formatCost(1234.5) === '$1234.50', 'formatCost(1234.5)');

// ── 2. basic aggregation + pricing ──
{
    const t = new UsageTracker();
    t.record({ provider: 'deepseek', model: 'deepseek-chat', promptTokens: 1000, completionTokens: 500, timestamp: 1, sessionKey: 'a' });
    t.record({ provider: 'deepseek', model: 'deepseek-chat', promptTokens: 1000, completionTokens: 500, timestamp: 2, sessionKey: 'a' });
    const s = t.snapshot();
    assert(s.total.requests === 2, 'total.requests = 2');
    assert(s.total.promptTokens === 2000, 'total.promptTokens = 2000');
    assert(s.total.completionTokens === 1000, 'total.completionTokens = 1000');
    assert(s.total.totalTokens === 3000, 'total.totalTokens = 3000');
    // deepseek pricing: $0.27 / 1M prompt, $1.10 / 1M completion
    const expectedCost = (2000 / 1e6) * 0.27 + (1000 / 1e6) * 1.10;
    assert(approx(s.total.estimatedCost, expectedCost), 'deepseek cost math');
    assert(s.byProvider.deepseek.requests === 2, 'byProvider.deepseek.requests');
    assert(s.bySession['a'].requests === 2, 'bySession[a].requests');
    assert(s.recent.length === 2, 'recent has 2 entries');
    assert(s.recent[0].timestamp === 2 && s.recent[1].timestamp === 1, 'recent order newest-first');
    assert(t.session('a').requests === 2, 'session("a") aggregate');
}

// ── 3. per-provider pricing (deepseek-responses / gemini / gemma4 / vision / unknown) ──
{
    const t = new UsageTracker();
    t.record({ provider: 'deepseek-responses', model: 'deepseek-reasoner', promptTokens: 1e6, completionTokens: 1e6, timestamp: 1 });
    // expected: $0.27 + $1.10
    assert(approx(t.snapshot().total.estimatedCost, 0.27 + 1.10), 'deepseek-responses cost');

    const t2 = new UsageTracker();
    t2.record({ provider: 'gemini', model: 'gemini-2.5-flash', promptTokens: 1e6, completionTokens: 1e6, timestamp: 1 });
    // expected: $0.30 + $2.50
    assert(approx(t2.snapshot().total.estimatedCost, 0.30 + 2.50), 'gemini cost');

    const t3 = new UsageTracker();
    t3.record({ provider: 'gemma4', model: 'gemma3:4b', promptTokens: 1e6, completionTokens: 1e6, timestamp: 1 });
    assert(t3.snapshot().total.estimatedCost === 0, 'gemma4 (local) cost is 0');

    const t4 = new UsageTracker();
    t4.record({ provider: 'vision', model: 'gemini-2.5-flash', promptTokens: 100000, completionTokens: 5000, timestamp: 1 });
    assert(approx(t4.snapshot().total.estimatedCost, (100000 / 1e6) * 0.30 + (5000 / 1e6) * 2.50), 'vision cost');

    const t5 = new UsageTracker();
    t5.record({ provider: 'unknown', promptTokens: 100, completionTokens: 100, timestamp: 1 });
    assert(t5.snapshot().total.estimatedCost === 0, 'unknown provider cost is 0');
    assert(t5.snapshot().byProvider.unknown.requests === 1, 'unknown provider counted');
}

// ── 4. session cap + LRU eviction (SESSION_CAP = 50) ──
{
    const t = new UsageTracker();
    // 60 distinct sessions — the 10 least-recently-used are evicted.
    for (let i = 0; i < 60; i++) {
        t.record({ provider: 'deepseek', promptTokens: 10, completionTokens: 10, timestamp: i, sessionKey: 's' + i });
    }
    const s = t.snapshot();
    // totals count ALL requests (eviction is only for the per-session map)
    assert(s.total.requests === 60, 'totals include evicted sessions');
    const keys = Object.keys(s.bySession);
    assert(keys.length === 50, 'bySession capped at 50 (' + keys.length + ')');
    assert(s.bySession['s0'] === undefined, 'oldest session evicted (s0)');
    assert(s.bySession['s9'] === undefined, 's9 evicted');
    assert(s.bySession['s10'] !== undefined, 'newest session kept (s10)');
    assert(s.bySession['s59'] !== undefined, 'newest session kept (s59)');
    // aggregate re-derived from the map
    assert(t.session('s59').requests === 1, 'kept session aggregate still correct');
}

// ── 5. recents cap (RECENT_CAP = 200) ──
{
    const t = new UsageTracker();
    for (let i = 0; i < 250; i++) {
        t.record({ provider: 'deepseek', promptTokens: 1, completionTokens: 1, timestamp: i, sessionKey: 'a' });
    }
    const s = t.snapshot();
    assert(s.recent.length === 200, 'recent capped at 200 (' + s.recent.length + ')');
    assert(s.recent[0].timestamp === 249, 'newest recents kept first');
    assert(s.recent[199].timestamp === 50, 'oldest recents evicted');
}

// ── 6. hydrate() round-trip + persistence callback ──
{
    const t = new UsageTracker();
    let saved;
    t.setPersistence((snap) => { saved = snap; });
    t.record({ provider: 'deepseek', model: 'deepseek-chat', promptTokens: 100, completionTokens: 50, timestamp: 42, sessionKey: 'x', sessionLabel: 'hello' });
    assert(saved !== undefined, 'persistence callback fired');
    assert(saved.total.requests === 1 && saved.total.totalTokens === 150, 'saved snapshot correct');

    const t2 = new UsageTracker();
    t2.hydrate(saved);
    const s2 = t2.snapshot();
    assert(s2.total.requests === 1 && s2.total.totalTokens === 150, 'hydrate restores totals');
    assert(s2.bySession['x'].requests === 1, 'hydrate restores bySession');
    assert(s2.sessionLabels['x'] === 'hello', 'hydrate restores session label');
    assert(s2.recent.length === 1, 'hydrate restores recents');
}

// ── 7. setPricing override ──
{
    const t = new UsageTracker();
    t.setPricing({ deepseek: { inputPerM: 1, outputPerM: 2 } });
    t.record({ provider: 'deepseek', promptTokens: 1e6, completionTokens: 1e6, timestamp: 1 });
    assert(approx(t.snapshot().total.estimatedCost, 3.0), 'setPricing override applied');
}

// ── 8. onDidChange listener ──
{
    const t = new UsageTracker();
    let fired = 0;
    t.onDidChange(() => fired++);
    t.record({ provider: 'deepseek', promptTokens: 1, completionTokens: 1, timestamp: 1 });
    t.record({ provider: 'deepseek', promptTokens: 1, completionTokens: 1, timestamp: 2 });
    assert(fired === 2, 'onDidChange fired per record');
    t.reset();
    assert(fired === 3, 'onDidChange fired on reset');
    assert(t.snapshot().total.requests === 0, 'reset clears totals');
}

// ── 9. record() NEVER throws (safety guarantee) ──
{
    const t = new UsageTracker();
    let threw = false;
    try {
        t.record(undefined);
        t.record(null);
        t.record({});
        t.record({ provider: 'bogus-provider', promptTokens: -5, completionTokens: 'nope', timestamp: 'x' });
        t.record({ provider: 'deepseek', promptTokens: 1, completionTokens: 1, timestamp: 1, sessionKey: 12345 });
        t.record({ provider: 'deepseek', promptTokens: 1, completionTokens: 1, timestamp: 1, sessionKey: { not: 'a string' } });
        t.snapshot();
        t.session(undefined);
        t.hydrate({ totally: 'garbage' });
        t.hydrate(undefined);
        // A valid record AFTER the garbage still works (hydrate reset state).
        t.record({ provider: 'deepseek', promptTokens: 1, completionTokens: 1, timestamp: 1 });
    } catch (e) {
        threw = true;
        console.error('  record() threw: ' + e);
    }
    assert(!threw, 'record()/snapshot()/session()/hydrate() never throw on bad input');
    const s = t.snapshot();
    assert(s.total.requests === 1, 'valid record counted after bad input + hydrate');
}

// ── 10. enabled flag gates recording ──
{
    const before = isUsageTrackingEnabled();
    setUsageTrackingEnabled(false);
    const t = new UsageTracker();
    t.record({ provider: 'deepseek', promptTokens: 100, completionTokens: 100, timestamp: 1 });
    assert(t.snapshot().total.requests === 0, 'record() is a no-op when disabled');
    setUsageTrackingEnabled(true);
    t.record({ provider: 'deepseek', promptTokens: 100, completionTokens: 100, timestamp: 2 });
    assert(t.snapshot().total.requests === 1, 'record() works again after re-enable');
    setUsageTrackingEnabled(before);
}

// ── 11. sessionLabels + lastUsed ──
{
    const t = new UsageTracker();
    t.record({ provider: 'deepseek', promptTokens: 1, completionTokens: 1, timestamp: 100, sessionKey: 'k', sessionLabel: 'fix pdf crash' });
    const s = t.snapshot();
    assert(s.sessionLabels['k'] === 'fix pdf crash', 'sessionLabels recorded');
    assert(s.bySession['k'].lastUsed === 100, 'lastUsed recorded');
    assert(s.total.lastUsed === 100, 'total.lastUsed = max timestamp');
}

// ── 12. aggregate by provider includes only seen providers ──
{
    const t = new UsageTracker();
    t.record({ provider: 'vision', promptTokens: 5, completionTokens: 5, timestamp: 1 });
    const s = t.snapshot();
    const provs = Object.keys(s.byProvider);
    assert(provs.length === 1 && provs[0] === 'vision', 'byProvider only contains seen providers');
}

// ── 13. latency telemetry + lastRequest (v0.7.85) ──
{
    const t = new UsageTracker();
    assert(t.lastRequest() === undefined, 'lastRequest undefined before any record');
    t.record({ provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 10, completionTokens: 5, timestamp: 100, latencyMs: 812 });
    t.record({ provider: 'deepseek', model: 'deepseek-v4-pro', promptTokens: 20, completionTokens: 10, timestamp: 200, latencyMs: 3200 });
    const last = t.lastRequest();
    assert(last && last.model === 'deepseek-v4-pro', 'lastRequest returns newest record');
    assert(last && last.latencyMs === 3200, 'latencyMs preserved on record');
    const s = t.snapshot();
    assert(s.recent[0].latencyMs === 3200, 'latencyMs survives snapshot');
    // hydrate round-trip keeps latency
    const t2 = new UsageTracker();
    t2.hydrate(s);
    assert(t2.lastRequest()?.latencyMs === 3200, 'latencyMs survives hydrate');
}

// ── 14. formatLatency (v0.7.85) ──
assert(formatLatency(0) === '0ms', 'formatLatency(0)');
assert(formatLatency(812) === '812ms', 'formatLatency(812)');
assert(formatLatency(1000) === '1.0s', 'formatLatency(1000)');
assert(formatLatency(3200) === '3.2s', 'formatLatency(3200)');
assert(formatLatency(65_000) === '1m 5s', 'formatLatency(65000)');
assert(formatLatency(undefined) === '—', 'formatLatency(undefined)');
assert(formatLatency(-5) === '—', 'formatLatency(negative)');
assert(formatLatency(NaN) === '—', 'formatLatency(NaN)');

console.log('');
console.log(`test-usage: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('Failures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
