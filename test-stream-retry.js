// test-stream-retry.js — verifies the transient stream-retry logic mirrors
// src/api/deepseek.ts (v0.7.64).
//
// The live provider path had NO retry: a transient mid-stream socket drop
// (DeepSeek "terminated" — the server closed the TLS connection ~4s in,
// before any output) threw `DeepSeek API stream interrupted: terminated`
// and killed the whole request. Fix: retry transient network/stream failures
// (socket drops, ECONNRESET/ETIMEDOUT, 429, 5xx) as long as NO output was
// emitted yet. A failure AFTER partial output is never retried (would
// duplicate text/tool calls). Aborts are never retried.
//
// This file mirrors the implementation so it stays runnable with plain node.

// ── Mirrors of src/api/deepseek.ts ──
const TRANSIENT_RE = /terminated|socket hang up|ECONNRESET|ETIMEDOUT|fetch failed|network|stream interrupted|temporarily unavailable|rate limit/i;

function isTransientStreamError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return TRANSIENT_RE.test(msg);
}

function isAbortError(err, signal) {
    if (signal && signal.aborted) return true;
    if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true;
    if (err instanceof Error && /abort/i.test(err.message)) return true;
    return false;
}

function backoffDelay(attempt, baseMs) {
    return Math.min(baseMs * 2 ** attempt, 4000);
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

async function retryStream(runOnce, canRetry, signal, options, label) {
    const retries = (options && options.retries) || 0;
    const baseMs = (options && options.backoffBaseMs) || 500;
    for (let attempt = 0; ; attempt++) {
        try {
            return await runOnce();
        } catch (err) {
            if (isAbortError(err, signal) || !canRetry() || !isTransientStreamError(err) || attempt >= retries) {
                throw err;
            }
            const delay = backoffDelay(attempt, baseMs);
            await sleep(delay, signal);
        }
    }
}

// Mirror of streamDeepSeekChat / streamDeepSeekResponses wrapper: flips
// `emitted` on any callback; retries only while NOT emitted.
function makeStreamWrapper(transport, retries, baseMs) {
    return async () => {
        let emitted = false;
        return retryStream(
            () => transport(
                () => { emitted = true; },
                () => { emitted = true; },
                () => { emitted = true; }
            ),
            () => !emitted,
            new AbortController().signal,
            { retries, backoffBaseMs: baseMs },
            'test stream'
        );
    };
}

// Mirror of getApiRetries (config.ts).
function getApiRetriesSafe(v) {
    return typeof v === 'number' && Number.isFinite(v)
        ? Math.max(0, Math.min(5, Math.floor(v)))
        : 2;
}

// ── Tiny harness ──
let checks = 0, fails = 0;
function ok(cond, name) {
    checks++;
    if (!cond) { fails++; console.log(`  ✗ ${name}`); }
}
function eq(a, b, name) {
    checks++;
    if (a !== b) { fails++; console.log(`  ✗ ${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
}

// ── 1. isTransientStreamError classification ──
function sectionTransient() {
    const transient = [
        'terminated',
        'socket hang up',
        'ECONNRESET',
        'ETIMEDOUT',
        'fetch failed',
        'Network error connecting to DeepSeek API: terminated',
        'DeepSeek API stream interrupted: terminated',
        'DeepSeek Responses stream interrupted: socket hang up',
        'DeepSeek API rate limit exceeded. Please wait and try again.',
        'DeepSeek service is temporarily unavailable. Please try again later.',
        'Failed to connect to DeepSeek API (...): network unreachable',
    ];
    for (const msg of transient) {
        ok(isTransientStreamError(new Error(msg)), `transient: "${msg}"`);
    }
    const permanent = [
        'DeepSeek API bad request: check your request parameters',
        'Invalid DeepSeek API key. Run "Nikas: Input Deepseek userToken" to update it.',
        'DeepSeek API: insufficient balance. Please top up your DeepSeek account.',
        'boom',
        'Unexpected end of JSON input',
    ];
    for (const msg of permanent) {
        ok(!isTransientStreamError(new Error(msg)), `not transient: "${msg}"`);
    }
}

// ── 2. isAbortError ──
function sectionAbort() {
    ok(isAbortError(new DOMException('The user aborted a request.', 'AbortError'), { aborted: false }), 'DOMException AbortError');
    ok(isAbortError(new Error('This operation was aborted'), { aborted: false }), 'abort message');
    ok(isAbortError(new Error('x'), { aborted: true }), 'signal aborted');
    ok(!isAbortError(new Error('terminated'), { aborted: false }), 'terminated is NOT abort');
    ok(!isAbortError(new Error('boom'), { aborted: false }), 'generic not abort');
}

// ── 3. backoffDelay ──
function sectionBackoff() {
    eq(backoffDelay(0, 500), 500, 'base 500 attempt 0');
    eq(backoffDelay(1, 500), 1000, 'base 500 attempt 1');
    eq(backoffDelay(2, 500), 2000, 'base 500 attempt 2');
    eq(backoffDelay(3, 500), 4000, 'cap at 4000');
    eq(backoffDelay(10, 500), 4000, 'still capped at 4000');
    eq(backoffDelay(0, 1), 1, 'test base');
}

// ── 4. retryStream behavior ──
async function sectionRetry() {
    // 4a: success on first try → 1 run, returns value.
    {
        let runs = 0;
        const wrapper = makeStreamWrapper(async () => { runs++; return 'ok'; }, 2, 1);
        const r = await wrapper();
        eq(r, 'ok', '4a success value');
        eq(runs, 1, '4a runs');
    }
    // 4b: transient failure then success → retried, returns value, 2 runs.
    {
        let runs = 0;
        const wrapper = makeStreamWrapper(async () => {
            runs++;
            if (runs === 1) throw new Error('DeepSeek API stream interrupted: terminated');
            return 'recovered';
        }, 2, 1);
        const r = await wrapper();
        eq(r, 'recovered', '4b recovered value');
        eq(runs, 2, '4b runs');
    }
    // 4c: output emitted before failure → NO retry (runs stays 1).
    {
        let runs = 0;
        const wrapper = makeStreamWrapper(async (onText) => {
            runs++;
            onText('partial');
            throw new Error('DeepSeek API stream interrupted: terminated');
        }, 2, 1);
        let threw = false;
        try { await wrapper(); } catch { threw = true; }
        ok(threw, '4c threw');
        eq(runs, 1, '4c no retry after partial output');
    }
    // 4d: abort → NO retry.
    {
        let runs = 0;
        const wrapper = makeStreamWrapper(async () => {
            runs++;
            throw new Error('This operation was aborted');
        }, 2, 1);
        let threw = false;
        try { await wrapper(); } catch { threw = true; }
        ok(threw, '4d threw on abort');
        eq(runs, 1, '4d no retry on abort');
    }
    // 4e: permanent error → NO retry.
    {
        let runs = 0;
        const wrapper = makeStreamWrapper(async () => {
            runs++;
            throw new Error('DeepSeek API bad request: check your request parameters');
        }, 2, 1);
        let threw = false;
        try { await wrapper(); } catch { threw = true; }
        ok(threw, '4e threw on permanent');
        eq(runs, 1, '4e no retry on permanent');
    }
    // 4f: exhausts retries → throws after retries+1 runs.
    {
        let runs = 0;
        const wrapper = makeStreamWrapper(async () => {
            runs++;
            throw new Error('DeepSeek API stream interrupted: terminated');
        }, 2, 1);
        let threw = false;
        try { await wrapper(); } catch { threw = true; }
        ok(threw, '4f threw after exhausting');
        eq(runs, 3, '4f runs = retries + 1 (3)');
    }
    // 4g: retries=0 → no retry at all.
    {
        let runs = 0;
        const wrapper = makeStreamWrapper(async () => {
            runs++;
            throw new Error('DeepSeek API stream interrupted: terminated');
        }, 0, 1);
        let threw = false;
        try { await wrapper(); } catch { threw = true; }
        ok(threw, '4g threw with retries=0');
        eq(runs, 1, '4g single run with retries=0');
    }
    // 4h: multiple transient failures then recovery.
    {
        let runs = 0;
        const wrapper = makeStreamWrapper(async () => {
            runs++;
            if (runs < 3) throw new Error('DeepSeek Responses stream interrupted: socket hang up');
            return 'after two failures';
        }, 2, 1);
        const r = await wrapper();
        eq(r, 'after two failures', '4h recovered value');
        eq(runs, 3, '4h runs = 3');
    }
}

// ── 5. getApiRetries clamp ──
function sectionConfig() {
    eq(getApiRetriesSafe(undefined), 2, 'undefined → 2');
    eq(getApiRetriesSafe(0), 0, '0 → 0 (disabled)');
    eq(getApiRetriesSafe(2), 2, '2 → 2');
    eq(getApiRetriesSafe(7), 5, '7 → capped at 5');
    eq(getApiRetriesSafe(-3), 0, '-3 → 0');
    eq(getApiRetriesSafe(2.7), 2, '2.7 → floor 2');
    eq(getApiRetriesSafe('2'), 2, 'non-number → 2');
    eq(getApiRetriesSafe(NaN), 2, 'NaN → 2');
}

// ── 2b. reader.read() catch decision (abort vs real interruption) ──
// Mirrors the read-loop catch in streamDeepSeekChat/streamDeepSeekResponses:
// aborts rethrow the ORIGINAL error (no ERROR log, never retried); real
// stream failures get wrapped as "stream interrupted" (retryable).
function readErrAction(readErr, signal) {
    if (isAbortError(readErr, signal)) return 'rethrow';
    return 'wrap';
}
function sectionReadErr() {
    eq(readErrAction(new DOMException('The user aborted a request.', 'AbortError'), { aborted: false }), 'rethrow', 'DOMException AbortError → rethrow (no ERROR log)');
    eq(readErrAction(new Error('This operation was aborted'), { aborted: false }), 'rethrow', 'abort message → rethrow (no ERROR log)');
    eq(readErrAction(new Error('x'), { aborted: true }), 'rethrow', 'signal aborted → rethrow');
    eq(readErrAction(new Error('terminated'), { aborted: false }), 'wrap', 'terminated → wrap (retryable)');
    eq(readErrAction(new Error('socket hang up'), { aborted: false }), 'wrap', 'socket hang up → wrap');
    eq(readErrAction(new Error('ECONNRESET'), { aborted: false }), 'wrap', 'ECONNRESET → wrap');
}

async function main() {
    sectionTransient();
    sectionAbort();
    sectionReadErr();
    sectionBackoff();
    await sectionRetry();
    sectionConfig();
    console.log(`${checks} checks, ${fails} fail`);
    if (fails > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
