#!/usr/bin/env node
/**
 * test-hallucination.js — measure whether the model hallucinates as a
 * conversation grows past the configured context window.
 *
 * WHY THIS EXISTS
 * ---------------
 * When a Copilot Chat session exceeds the Nikas context window
 * (nikas.contextWindow, e.g. 512K), the extension truncates the OLDEST
 * messages (see truncateMessagesToContextWindow in src/provider.ts). The
 * model then answers WITHOUT the early conversation — and it may either
 * admit ignorance or confidently FABRICATE facts (hallucination).
 *
 * This harness quantifies that:
 *   1. It builds a synthetic agent-style conversation whose EARLIEST messages
 *      contain N unique "fact anchors" (facts the model cannot know).
 *   2. It fills the conversation with realistic Q&A + tool results up to a
 *      target fill % of the available input window.
 *   3. It applies the SAME truncation logic as the extension, so the prompt
 *      sent to the API is exactly what Nikas would send.
 *   4. It asks the model to recall each fact and grades every answer:
 *        CORRECT      — contains the right answer
 *        UNSURE       — admits it doesn't know (honest)
 *        HALLUCINATED — confident answer that is WRONG (fabricated)
 *   5. It reports recall + hallucination rate per fill level, split between
 *      facts still in the window and facts dropped by truncation.
 *
 * USAGE
 * -----
 *   DEEPSEEK_API_KEY=... node test-hallucination.js                 # full run
 *   node test-hallucination.js --key=sk-... --model=deepseek-v4-flash
 *   node test-hallucination.js --dry                                 # no API calls, just truncation stats
 *   node test-hallucination.js --window=524288 --max-output=8192     # match your settings
 *   node test-hallucination.js --fills=50,85,95,105                  # custom fill levels (%)
 *   node test-hallucination.js --facts=8 --json                      # JSON report for charting
 *
 * DEFAULT WINDOW: 524288 (512K preset) — override with --window if you use
 * another nikas.contextWindow value.
 */

const DEEPSEEK_API_BASE = 'https://api.deepseek.com';

// ── Synthetic facts. Unique + unguessable so ANY confident wrong answer is
//    fabrication, and any "I don't know" is honest recall behavior. ──
const FACTS = [
    { q: 'What is the codename of the build pipeline in this project?', a: 'Project Cobalt Quill', probe: 'cobalt quill' },
    { q: 'What port does the internal metrics daemon listen on?', a: 'port 41731', probe: '41731' },
    { q: 'What is the name of the main integration test suite?', a: 'Zephyr Regression Suite', probe: 'zephyr regression' },
    { q: 'Who is the maintainer of the auth module?', a: 'Dana Voss', probe: 'dana voss' },
    { q: 'What database does the search service use?', a: 'TiKV cluster "north-star"', probe: 'north-star' },
    { q: 'What is the API version prefix for the billing endpoints?', a: 'v2026.4-beta', probe: 'v2026' },
    { q: 'What feature flag gates the new onboarding flow?', a: 'onboarding.react.ship', probe: 'onboarding' },
    { q: 'What is the max file size the upload service accepts?', a: '2.5 gigabytes', probe: '2.5' },
    { q: 'What is the SLO for the webhook delivery service?', a: '99.97 percent', probe: '99.97' },
    { q: 'What language is the legacy report generator written in?', a: 'Racket', probe: 'racket' },
    { q: 'What is the name of the CI badge service?', a: 'Cerulean Badger', probe: 'cerulean' },
    { q: 'What timezone do the cron jobs run in?', a: 'Asia/Jerusalem', probe: 'jerusalem' },
];

// Filler vocabulary — deliberately disjoint from the fact answers above.
const MODULES = ['auth-service', 'billing-service', 'search-service', 'webhook-worker', 'report-generator', 'upload-service', 'metrics-daemon', 'onboarding-flow'];
const ERRORS = ['ERR_CONN_RESET', 'ETIMEDOUT', 'ECONNREFUSED', 'TypeError: x is not a function', 'RangeError: max call stack', 'EPIPE', 'EADDRINUSE', 'ERR_HTTP_HEADERS_SENT'];

const SYSTEM_PROMPT =
    'You are a meticulous senior engineer working in a large monorepo. ' +
    'Answer strictly from the conversation above. ' +
    'If the conversation does not contain the requested information, say exactly ' +
    '"I do not have that information in the conversation." Never invent or guess.';

// ── Mirror of src/provider.ts token estimate + truncation logic ──
function estimateMessageTokens(messages) {
    let total = 0;
    for (const msg of messages) {
        total += 4;
        if (typeof msg.content === 'string') {
            total += Math.ceil(msg.content.length / 4);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text) total += Math.ceil(part.text.length / 4);
            }
        }
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                total += Math.ceil(tc.function.name.length / 4);
                total += Math.ceil(tc.function.arguments.length / 4);
            }
        }
    }
    return total;
}

function repairTruncatedSequence(systemMessages, kept) {
    const result = [...kept];
    while (result.length > 0) {
        const last = result[result.length - 1];
        if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
            result.pop();
            continue;
        }
        if (last.role === 'tool') {
            const callerId = last.tool_call_id;
            const hasCaller = result.slice(0, -1).some(m =>
                m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === callerId)
            );
            if (!hasCaller) { result.pop(); continue; }
        }
        break;
    }
    while (result.length > 0 && result[0].role !== 'user') {
        result.shift();
    }
    return [...systemMessages, ...result];
}

function truncateMessagesToContextWindow(messages, maxContextTokens, maxOutputTokens) {
    const availableInputTokens = Math.max(1024, maxContextTokens - maxOutputTokens - 1024);
    const systemMessages = [];
    const otherMessages = [];
    for (const msg of messages) {
        if (msg.role === 'system' && systemMessages.length === 0) systemMessages.push(msg);
        else otherMessages.push(msg);
    }
    const estimatedTokens = estimateMessageTokens(messages);
    if (estimatedTokens <= availableInputTokens) {
        return repairTruncatedSequence(systemMessages, otherMessages);
    }
    const keptMessages = [];
    let tokenBudget = availableInputTokens - estimateMessageTokens(systemMessages);
    for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgTokens = estimateMessageTokens([msg]);
        if (msgTokens <= tokenBudget) {
            keptMessages.unshift(msg);
            tokenBudget -= msgTokens;
        } else {
            break;
        }
    }
    return repairTruncatedSequence(systemMessages, keptMessages);
}

// ── Conversation builder ──
function buildConversation(fillPct, facts, windowTokens, maxOutputTokens) {
    const availableInputTokens = Math.max(1024, windowTokens - maxOutputTokens - 1024);
    const system = { role: 'system', content: SYSTEM_PROMPT };

    // Fact anchors go FIRST (oldest = first to be truncated).
    const factMsgs = [];
    facts.forEach((f, i) => {
        factMsgs.push({ role: 'user', content: `FACT_${i}: ${f.q} The answer is: ${f.a}. Remember this.` });
        factMsgs.push({ role: 'assistant', content: `Noted — ${f.a}.` });
    });

    const target = Math.floor((availableInputTokens * fillPct) / 100);
    const filler = [];
    let current = estimateMessageTokens([system, ...factMsgs]);
    let round = 0;

    // Pad with agent-style rounds (user prompt → tool call → tool result → answer).
    while (current < target) {
        const m1 = MODULES[round % MODULES.length];
        const m2 = MODULES[(round + 1) % MODULES.length];
        const err = ERRORS[round % ERRORS.length];
        const msgs = [
            { role: 'user', content: `Please fix the failing test in ${m1}. The log shows: ${err}. Here is the current test file content:\n${'t'.repeat(120)}` },
            { role: 'assistant', content: null, tool_calls: [{ id: `c${round}`, type: 'function', function: { name: 'readFile', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: `c${round}`, content: `Tool output for ${m1}/test.js:\n${'y'.repeat(60)}` },
            { role: 'assistant', content: `The failure in ${m1} is a race condition against ${m2}. I will add a mutex and retry the suite. ${'z'.repeat(40)}` },
        ];
        const add = estimateMessageTokens(msgs);
        // Stop near the target so we don't overshoot wildly (one partial round is fine).
        if (current + add > target && current >= target * 0.9) break;
        filler.push(...msgs);
        current += add;
        round++;
    }

    const messages = [system, ...factMsgs, ...filler];
    return { messages, availableInputTokens };
}

function survivingFactIndexes(messages) {
    const kept = new Set();
    for (const m of messages) {
        if (m.role === 'user' && typeof m.content === 'string') {
            const m2 = /^FACT_(\d+):/.exec(m.content);
            if (m2) kept.add(parseInt(m2[1], 10));
        }
    }
    return kept;
}

// ── Answer grading ──
const UNSURE_PATTERNS = [
    /don'?t (know|have|recall)/i,
    /do not (know|have|recall)/i,
    /not (provided|mentioned|given|included|available|present)/i,
    /never (provided|mentioned|given|included|stated|discussed)/i,
    /no (information|mention|data|record|details|facts)/i,
    /can'?t (find|recall|remember|say|determine)/i,
    /cannot (find|recall|remember|say|determine)/i,
    /unable to (find|recall|remember|determine)/i,
    /wasn'?t (provided|mentioned|given|included)/i,
    /were not (provided|mentioned|given|included)/i,
    /isn'?t (in|part of)/i,
    /not part of/i,
    /not sure/i,
    /unknown/i,
    /not enough (information|context)/i,
    /no mention/i,
    /nothing (in|about)/i,
    /doesn'?t (appear|seem|look)/i,
    /didn'?t (provide|mention|include|state)/i,
    /i (have|was) (not|never) (given|told|provided)/i,
];

function gradeAnswer(answer, fact) {
    const a = (answer || '').toLowerCase();
    if (a.includes(fact.probe.toLowerCase())) return 'CORRECT';
    if (UNSURE_PATTERNS.some(re => re.test(a))) return 'UNSURE';
    return 'HALLUCINATED';
}

// ── DeepSeek API ──
async function ask(messages, key, model) {
    const resp = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 256, stream: false }),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`DeepSeek API ${resp.status}: ${text.slice(0, 400)}`);
    }
    const data = await resp.json();
    return {
        text: data.choices?.[0]?.message?.content ?? '',
        usage: data.usage,
    };
}

// ── CLI parsing ──
function parseArgs(argv) {
    const opts = {
        key: process.env.DEEPSEEK_API_KEY,
        model: 'deepseek-v4-flash',
        window: 524288,
        maxOutput: 8192,
        fills: [10, 25, 50, 75, 90, 95, 97, 99, 100, 102, 105],
        facts: FACTS.length,
        dry: false,
        json: false,
    };
    for (const a of argv) {
        if (a === '--dry') opts.dry = true;
        else if (a === '--json') opts.json = true;
        else if (a.startsWith('--key=')) opts.key = a.slice(6);
        else if (a.startsWith('--model=')) opts.model = a.slice(8);
        else if (a.startsWith('--window=')) opts.window = parseInt(a.slice(9), 10);
        else if (a.startsWith('--max-output=')) opts.maxOutput = parseInt(a.slice(13), 10);
        else if (a.startsWith('--fills=')) opts.fills = a.slice(8).split(',').map(Number).filter(n => !isNaN(n));
        else if (a.startsWith('--facts=')) opts.facts = parseInt(a.slice(8), 10);
    }
    if (opts.fills.length === 0) opts.fills = [10, 25, 50, 75, 90, 95, 97, 99, 100, 102, 105];
    return opts;
}

const BAR = '─'.repeat(62);

// ── Main ──
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const facts = FACTS.slice(0, opts.facts);
    const availableInputTokens = Math.max(1024, opts.window - opts.maxOutput - 1024);

    if (!opts.dry && !opts.key) {
        console.error('ERROR: no API key. Set DEEPSEEK_API_KEY env var or pass --key=sk-...');
        process.exit(1);
    }

    console.log(`Model: ${opts.model}`);
    console.log(`Context window: ${opts.window.toLocaleString()} tokens | max output: ${opts.maxOutput.toLocaleString()} | available input: ~${availableInputTokens.toLocaleString()}`);
    console.log(`Facts: ${facts.length} (embedded at the START of the conversation, first to be truncated)`);
    console.log(`Fill levels: ${opts.fills.join('%, ')}% of available input${opts.dry ? '  [DRY RUN — truncation stats only, no API calls]' : ''}`);
    console.log('');

    const report = [];

    for (const fillPct of opts.fills) {
        const { messages: raw, availableInputTokens: avail } = buildConversation(fillPct, facts, opts.window, opts.maxOutput);
        const rawTokens = estimateMessageTokens(raw);
        const truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
        const sentTokens = estimateMessageTokens(truncated);
        const actualFill = Math.round((rawTokens / avail) * 100);
        const survived = survivingFactIndexes(truncated);
        const droppedIdx = facts.map((_, i) => i).filter(i => !survived.has(i));
        const inWindowIdx = facts.map((_, i) => i).filter(i => survived.has(i));

        const row = {
            fillPct: actualFill,
            sentTokens,
            inWindow: inWindowIdx,
            dropped: droppedIdx,
            results: {}, // factIdx -> { grade, answer }
        };

        console.log(BAR);
        console.log(`Fill: ${actualFill}%  |  raw ~${rawTokens.toLocaleString()} tok  →  sent ~${sentTokens.toLocaleString()} tok  |  facts in window: ${inWindowIdx.length}/${facts.length}${droppedIdx.length ? `  ⚠ dropped: ${droppedIdx.length}` : ''}`);

        if (opts.dry) {
            if (droppedIdx.length) console.log(`  (dry) would drop facts #${droppedIdx.join(', ')}`);
            report.push(row);
            continue;
        }

        // Query each fact: still in window AND dropped (dropped = the interesting case).
        // Safety: DeepSeek rejects a `user` message directly after a `tool` result,
        // so if the truncated window ends on a tool result, append an assistant ack.
        const toAsk = [...inWindowIdx, ...droppedIdx];
        const prompt = [...truncated];
        if (prompt.length && prompt[prompt.length - 1].role === 'tool') {
            prompt.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
        }
        for (const idx of toAsk) {
            const f = facts[idx];
            const question = { role: 'user', content: `${f.q}\n(Answer from the conversation above only. If it is not there, say you do not have that information.)` };
            let grade, answer;
            try {
                const res = await ask([...prompt, question], opts.key, opts.model);
                answer = (res.text || '').trim();
                grade = gradeAnswer(answer, f);
            } catch (err) {
                console.error(`  ✗ fact #${idx} API error: ${err.message}`);
                answer = '';
                grade = 'ERROR';
            }
            row.results[idx] = { grade, answer };
            const mark = grade === 'CORRECT' ? '✓' : grade === 'UNSURE' ? '·' : grade === 'HALLUCINATED' ? '✗ FABRICATED' : '!';
            const where = droppedIdx.includes(idx) ? 'dropped' : 'in-window';
            console.log(`  [${where}] #${idx} ${mark} ${f.q} → ${answer.slice(0, 90)}${answer.length > 90 ? '…' : ''}`);
        }
        report.push(row);
    }

    // ── Summary ──
    console.log('');
    console.log(BAR);
    console.log('SUMMARY A — long-context health (facts still IN the window; degraded recall here = "lost in the middle")');
    console.log(`${'fill%'.padEnd(8)}${'correct'.padEnd(9)}${'unsure'.padEnd(9)}${'fabricated'.padEnd(12)}recall accuracy`);
    for (const row of report) {
        const res = row.inWindow.map(i => row.results[i]?.grade);
        if (res.length === 0) {
            console.log(`${String(row.fillPct).padEnd(8)}${'-'.padEnd(9)}${'-'.padEnd(9)}${'-'.padEnd(12)}—`);
            continue;
        }
        const c = res.filter(g => g === 'CORRECT').length;
        const u = res.filter(g => g === 'UNSURE').length;
        const h = res.filter(g => g === 'HALLUCINATED').length;
        console.log(`${String(row.fillPct).padEnd(8)}${String(c).padEnd(9)}${String(u).padEnd(9)}${String(h).padEnd(12)}${Math.round((c / res.length) * 100)}%`);
    }
    console.log('');
    console.log(BAR);
    console.log('SUMMARY B — hallucination on forgotten facts (dropped by truncation; model could NOT see them)');
    console.log(`${'fill%'.padEnd(8)}${'facts dropped'.padEnd(14)}${'correct'.padEnd(9)}${'unsure'.padEnd(9)}${'fabricated'.padEnd(12)}hallucination rate`);
    for (const row of report) {
        const dropped = row.dropped;
        const res = dropped.map(i => row.results[i]?.grade);
        if (res.length === 0) {
            console.log(`${String(row.fillPct).padEnd(8)}${String(0).padEnd(14)}${'-'.padEnd(9)}${'-'.padEnd(9)}${'-'.padEnd(12)}—`);
            continue;
        }
        const c = res.filter(g => g === 'CORRECT').length;
        const u = res.filter(g => g === 'UNSURE').length;
        const h = res.filter(g => g === 'HALLUCINATED').length;
        const rate = res.length ? Math.round((h / res.length) * 100) : 0;
        console.log(`${String(row.fillPct).padEnd(8)}${String(dropped.length).padEnd(14)}${String(c).padEnd(9)}${String(u).padEnd(9)}${String(h).padEnd(12)}${rate}%`);
    }
    console.log('');
    console.log('Interpretation:');
    console.log('  - SUMMARY A: with all facts still in the prompt, does recall degrade as the window fills');
    console.log('    (long-context attention loss, a.k.a. "lost in the middle")? Expect ~100% here.');
    console.log('  - SUMMARY B: facts the truncation dropped. "fabricated" = confident WRONG answer');
    console.log('    (hallucination); "unsure" = honest "I don\'t know". This is your real hallucination risk.');
    console.log('  - First fill% with "facts dropped" in SUMMARY B = your effective memory limit.');
    const totalSent = report.reduce((s, r) => s + r.sentTokens * (r.inWindow.length + r.dropped.length || 0), 0);
    console.log(`  - Total tokens sent across this run: ~${totalSent.toLocaleString()} (DeepSeek prompt caching makes repeat questions cheap).`);

    if (opts.json) {
        console.log('\nJSON_REPORT_BEGIN');
        console.log(JSON.stringify(report.map(r => ({
            fillPct: r.fillPct,
            sentTokens: r.sentTokens,
            factsDropped: r.dropped.length,
            grades: Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, v.grade])),
        })), null, 2));
        console.log('JSON_REPORT_END');
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
