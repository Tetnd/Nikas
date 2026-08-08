#!/usr/bin/env node
/**
 * test-hallucination.js — find the point where the model starts producing
 * bad code / hallucinating as the conversation fills the context window.
 *
 * WHY THIS EXISTS
 * ---------------
 * When a Copilot Chat session exceeds the Nikas context window
 * (nikas.contextWindow, e.g. 1M), the extension truncates the OLDEST
 * messages (see truncateMessagesToContextWindow in src/provider.ts). The
 * model then answers WITHOUT the early conversation — and it may either
 * admit ignorance or confidently FABRICATE facts / write plausible-but-wrong
 * code (hallucination).
 *
 * Two scenarios:
 *   --scenario=recall  (facts)  — embed N unguessable facts at the start,
 *                                 ask the model to recall them, grade
 *                                 CORRECT / UNSURE / HALLUCINATED.
 *   --scenario=code    (default)— embed fake project "conventions" (an
 *                                 internal API the model cannot know), fill
 *                                 the window, then ask it to WRITE CODE that
 *                                 must use those conventions. Grade contract
 *                                 compliance — the direct proxy for "bad
 *                                 code" (phantom utilities, wrong APIs).
 *
 * API mode (matches the extension's two DeepSeek paths):
 *   --api=chat       (default) — POST /chat/completions, model deepseek-v4-flash
 *   --api=responses            — POST /responses, model deepseek-v4-flash
 *                                (mirrors the extension's
 *                                deepseekMessagesToResponsesInput conversion
 *                                + Responses wire format)
 *
 * Thinking (matches the extension's buildThinkingParams /
 * buildResponsesThinkingParams):
 *   --thinking=off   (default) — thinking DISABLED (DeepSeek V4 defaults to
 *                                thinking ON when the param is absent, which
 *                                eats the whole output budget → empty replies.
 *                                The extension always sends the param, so we
 *                                must too, or we measure empty responses.)
 *   --thinking=low|high|max    — enable thinking; the harness then uses the
 *                                extension's boosted output budget (16K)
 *
 * USAGE
 * -----
 *   DEEPSEEK_API_KEY=... node test-hallucination.js --find-limit     # NEW LIMIT scan (code)
 *   DEEPSEEK_API_KEY=... node test-hallucination.js --api=responses  # via Responses API
 *   DEEPSEEK_API_KEY=... node test-hallucination.js                   # code scan, default fills
 *   DEEPSEEK_API_KEY=... node test-hallucination.js --scenario=recall
 *   node test-hallucination.js --dry                                 # truncation stats only, no API
 *   node test-hallucination.js --window=1000000 --max-output=8192    # match your settings
 *   node test-hallucination.js --fills=20,50,80,99 --tasks=3
 *   node test-hallucination.js --model=deepseek-v4-pro --threshold=80
 *
 * DEFAULT WINDOW: 1000000 (1M preset) — override with --window.
 * Baseline from the field (DeepSeek V4, 1M window, r/LocalLLaMA):
 *   solid < 150K, precision loss past ~300K, coding degrades 256-520K.
 * This harness measures YOUR number on YOUR model.
 */

const DEEPSEEK_API_BASE = 'https://api.deepseek.com';
const DEEPSEEK_CHAT_ENDPOINT = `${DEEPSEEK_API_BASE}/chat/completions`;
const DEEPSEEK_RESPONSES_ENDPOINT = `${DEEPSEEK_API_BASE}/responses`;

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

// ── Code conventions (for --scenario=code). A made-up internal API the model
//    cannot know. If its generated code uses these names, the conventions
//    survived the context fill. If it writes generic fetch/try-catch/
//    console.log/setTimeout instead, it forgot them — that is bad code. ──
const CODE_CONTRACTS = [
    {
        name: 'canonical client',
        rule: 'The canonical HTTP client is createClient("northstar") from "@acme/core". Always use it — never raw fetch().',
        probes: ['createclient', 'northstar'],
        antiProbes: ['fetch('],
    },
    {
        name: 'retry helper',
        rule: 'Every network call must be wrapped with withRetry(fn, { attempts: 5 }).',
        probes: ['withretry'],
        antiProbes: [],
    },
    {
        name: 'Result errors',
        rule: 'Error handling uses Result<T> — return .err()/.ok() (or check .isErr()). Never throw new Error().',
        probes: ['result<', '.err(', '.ok(', '.iserr('],
        antiProbes: ['throw new error'],
    },
    {
        name: 'timeout helper',
        rule: 'Waiting uses delay(ms) from "@acme/timers". setTimeout is banned.',
        probes: ['delay('],
        antiProbes: ['settimeout('],
    },
    {
        name: 'structured logging',
        rule: 'Logging uses the structured logger (logger.info/warn/error). console.log is banned.',
        probes: ['logger.'],
        antiProbes: ['console.log'],
    },
    {
        name: 'feature flag',
        rule: 'New behavior is gated behind flags.enabled("onboarding.react.ship").',
        probes: ['flags.enabled', 'onboarding.react.ship'],
        antiProbes: [],
    },
];

// Code tasks used at each probe. Both share the SAME conversation prefix, so
// DeepSeek prompt caching makes every task after the first cheap.
const CODE_TASKS = [
    'Write a TypeScript function `fetchUserProfile(userId: string): Promise<Result<UserProfile>>` for the billing-service. ' +
    'Follow the project conventions from the beginning of the conversation EXACTLY: create the client the canonical way (never raw fetch), ' +
    'wrap network calls in the retry helper, handle failures with the Result type (never throw), use the timeout helper instead of setTimeout, ' +
    'use the structured logger (never console.log), and gate the new behavior behind the feature flag. ' +
    'Return ONLY a single ```typescript code block, no explanations.',
    'Write a TypeScript function `sendWebhook(event: WebhookEvent): Promise<Result<void>>` for the webhook-worker. ' +
    'Follow the project conventions from the beginning of the conversation EXACTLY: create the client the canonical way (never raw fetch), ' +
    'wrap network calls in the retry helper, handle failures with the Result type (never throw), use the timeout helper instead of setTimeout, ' +
    'use the structured logger (never console.log), and gate the new behavior behind the feature flag. ' +
    'Return ONLY a single ```typescript code block, no explanations.',
];

// Filler vocabulary — deliberately disjoint from the fact answers above.
const MODULES = ['auth-service', 'billing-service', 'search-service', 'webhook-worker', 'report-generator', 'upload-service', 'metrics-daemon', 'onboarding-flow'];
const ERRORS = ['ERR_CONN_RESET', 'ETIMEDOUT', 'ECONNREFUSED', 'TypeError: x is not a function', 'RangeError: max call stack', 'EPIPE', 'EADDRINUSE', 'ERR_HTTP_HEADERS_SENT'];

const SYSTEM_PROMPT =
    'You are a meticulous senior engineer working in a large monorepo. ' +
    'The conversation begins with facts and project conventions marked FACT_n / CONTRACT_n. ' +
    'Answer strictly from the conversation above. ' +
    'If the conversation does not contain the requested information, say exactly ' +
    '"I do not have that information in the conversation." Never invent or guess. ' +
    'When asked to write code, follow the CONTRACT_n project conventions EXACTLY.';

// ── Mirror of src/provider.ts token estimate + truncation logic ──
// NOTE: the estimator is calibrated ×1.4 to match real API token counts
// (measured real/est ≈ 1.40), mirroring ESTIMATE_CALIBRATION in provider.ts.
const ESTIMATE_CALIBRATION = 1.4;

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
    return Math.ceil(total * ESTIMATE_CALIBRATION);
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
function buildConversation(fillPct, anchorMsgs, windowTokens, maxOutputTokens) {
    const availableInputTokens = Math.max(1024, windowTokens - maxOutputTokens - 1024);
    const system = { role: 'system', content: SYSTEM_PROMPT };

    // Anchors (facts or code conventions) go FIRST — oldest = first to be truncated.
    const factMsgs = anchorMsgs;

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

function survivingAnchorIndexes(messages, prefix) {
    const kept = new Set();
    const re = new RegExp(`^${prefix}_(\\d+):`);
    for (const m of messages) {
        if (m.role === 'user' && typeof m.content === 'string') {
            const m2 = re.exec(m.content);
            if (m2) kept.add(parseInt(m2[1], 10));
        }
    }
    return kept;
}

function buildAnchorMessages(anchors, prefix) {
    const msgs = [];
    anchors.forEach((a, i) => {
        msgs.push({ role: 'user', content: `${prefix}_${i}: ${a.user}` });
        msgs.push({ role: 'assistant', content: a.assistant });
    });
    return msgs;
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

/**
 * Grade generated code against the contract list. Each contract is:
 *   satisfied — a required probe appeared in the code
 *   violated   — a forbidden anti-probe appeared (probe missing)
 *   neither    — the convention was simply omitted (also a failure)
 */
function gradeCode(answer, contracts) {
    const a = (answer || '').toLowerCase();
    return contracts.map((c, i) => ({
        idx: i,
        name: c.name,
        satisfied: c.probes.some(p => a.includes(p.toLowerCase())),
        violated: c.antiProbes.some(p => a.includes(p.toLowerCase())),
    }));
}

// ── DeepSeek API ──

/**
 * Convert chat-completions messages to Responses API input items.
 * Mirrors src/transform/messages.ts deepseekMessagesToResponsesInput:
 *   system → top-level `instructions` (first one) or `message` item
 *   user   → `message` item (role: user)
 *   assistant text → `message` item (role: assistant)
 *   assistant tool_calls → adjacent `function_call` items
 *   tool result → `function_call_output` item
 */
function messagesToResponsesInput(messages) {
    const input = [];
    let instructions;
    for (const msg of messages) {
        if (msg.role === 'system') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            if (!instructions && text) instructions = text;
            else input.push({ type: 'message', role: 'system', content: text });
            continue;
        }
        if (msg.role === 'user') {
            input.push({ type: 'message', role: 'user', content: typeof msg.content === 'string' ? msg.content : '' });
            continue;
        }
        if (msg.role === 'assistant') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            if (text) input.push({ type: 'message', role: 'assistant', content: text });
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    input.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    });
                }
            }
            continue;
        }
        if (msg.role === 'tool' && msg.tool_call_id) {
            input.push({
                type: 'function_call_output',
                call_id: msg.tool_call_id,
                output: typeof msg.content === 'string' ? msg.content : '',
            });
            continue;
        }
    }
    return { input, instructions };
}

/** Concatenate text from a Responses API response output array. */
function responsesText(output) {
    let text = '';
    for (const item of output || []) {
        if (item.type === 'message') {
            const content = item.content;
            if (typeof content === 'string') text += content;
            else if (Array.isArray(content)) {
                for (const part of content) {
                    if ((part.type === 'output_text' || part.type === 'input_text') && part.text) text += part.text;
                }
            }
        }
    }
    return text;
}

/**
 * Thinking params, mirroring the extension's buildThinkingParams
 * (chat-completions) and buildResponsesThinkingParams (responses).
 * CRITICAL: DeepSeek V4 enables thinking BY DEFAULT when the param is absent
 * and silently burns the entire output budget on reasoning tokens, returning
 * empty visible text. The extension always sends the param — so must we.
 */
function thinkingParamsFor(thinking, api) {
    if (thinking === 'off') {
        return api === 'responses' ? { reasoning: { effort: 'none' } } : { thinking: { type: 'disabled' } };
    }
    if (api === 'responses') return { reasoning: { effort: thinking } };
    return { thinking: { type: 'enabled' }, reasoning_effort: thinking };
}

/**
 * Output token budget, mirroring provider.ts boostedTokens:
 *   thinking off → maxTokens (default 8K)
 *   thinking on  → max(8K, 16K) so reasoning gets headroom and visible
 *                  output still fits (the "empty response" fix)
 */
function outputBudgetFor(thinking, baseMax) {
    return thinking === 'off' ? baseMax : Math.max(baseMax, 16384);
}

async function ask(messages, key, model, maxTokens = 256, api = 'chat', thinking = 'off') {
    if (api === 'responses') {
        const { input, instructions } = messagesToResponsesInput(messages);
        const body = {
            model: 'deepseek-v4-flash', // /responses only accepts flash
            input,
            stream: false,
            max_output_tokens: outputBudgetFor(thinking, maxTokens),
            temperature: 0,
            ...thinkingParamsFor(thinking, api),
        };
        if (instructions) body.instructions = instructions;
        const resp = await fetch(DEEPSEEK_RESPONSES_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`DeepSeek Responses API ${resp.status}: ${text.slice(0, 400)}`);
        }
        const data = await resp.json();
        return {
            text: responsesText(data.output || []).trim(),
            usage: data.usage,
        };
    }

    const resp = await fetch(DEEPSEEK_CHAT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            max_tokens: outputBudgetFor(thinking, maxTokens),
            stream: false,
            ...thinkingParamsFor(thinking, api),
        }),
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
        window: 1000000,
        maxOutput: 8192,
        fills: null, // resolved per scenario in main()
        facts: FACTS.length,
        scenario: 'code',
        findLimit: false,
        tasksPerProbe: 2,
        threshold: 75,
        api: 'chat',
        thinking: 'off',
        diag: false,
        diagFill: 10,
        dry: false,
        json: false,
    };
    for (const a of argv) {
        if (a === '--dry') opts.dry = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--find-limit') opts.findLimit = true;
        else if (a === '--diag') opts.diag = true;
        else if (a.startsWith('--diag-fill=')) opts.diagFill = parseInt(a.slice(12), 10);
        else if (a.startsWith('--thinking=')) opts.thinking = a.slice(11);
        else if (a.startsWith('--key=')) opts.key = a.slice(6);
        else if (a.startsWith('--model=')) opts.model = a.slice(8);
        else if (a.startsWith('--window=')) opts.window = parseInt(a.slice(9), 10);
        else if (a.startsWith('--max-output=')) opts.maxOutput = parseInt(a.slice(13), 10);
        else if (a.startsWith('--fills=')) opts.fills = a.slice(8).split(',').map(Number).filter(n => !isNaN(n));
        else if (a.startsWith('--facts=')) opts.facts = parseInt(a.slice(8), 10);
        else if (a.startsWith('--scenario=')) opts.scenario = a.slice(11);
        else if (a.startsWith('--tasks=')) opts.tasksPerProbe = parseInt(a.slice(8), 10);
        else if (a.startsWith('--threshold=')) opts.threshold = parseInt(a.slice(12), 10);
        else if (a.startsWith('--api=')) opts.api = a.slice(6);
    }
    if (opts.api !== 'chat' && opts.api !== 'responses') {
        console.error(`ERROR: unknown --api=${opts.api} (use 'chat' or 'responses')`);
        process.exit(1);
    }
    if (!['off', 'low', 'high', 'max'].includes(opts.thinking)) {
        console.error(`ERROR: unknown --thinking=${opts.thinking} (use off|low|high|max)`);
        process.exit(1);
    }
    if (!opts.fills || opts.fills.length === 0) {
        opts.fills = opts.scenario === 'recall'
            ? [10, 25, 50, 75, 90, 95, 97, 99, 100, 102, 105]
            : [10, 25, 40, 50, 60, 70, 80, 90, 99];
    }
    return opts;
}

const BAR = '─'.repeat(62);

// ── Main ──
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const isCode = opts.scenario === 'code';
    const prefix = isCode ? 'CONTRACT' : 'FACT';
    const anchors = isCode ? CODE_CONTRACTS : FACTS.slice(0, opts.facts);
    const anchorSpecs = isCode
        ? CODE_CONTRACTS.map(c => ({ user: `PROJECT CONVENTION ${c.name}: ${c.rule}`, assistant: `Understood — ${c.name} is ${c.rule}.` }))
        : FACTS.slice(0, opts.facts).map(f => ({ user: `${f.q} The answer is: ${f.a}. Remember this.`, assistant: `Noted — ${f.a}.` }));
    const anchorMsgs = buildAnchorMessages(anchorSpecs, prefix);
    const availableInputTokens = Math.max(1024, opts.window - opts.maxOutput - 1024);

    if (!opts.dry && !opts.key) {
        console.error('ERROR: no API key. Set DEEPSEEK_API_KEY env var or pass --key=sk-...');
        process.exit(1);
    }
    if (opts.findLimit && !isCode) {
        console.error('ERROR: --find-limit requires --scenario=code (it measures code-quality degradation).');
        process.exit(1);
    }

    console.log(`Model: ${opts.model}  (API: /${opts.api === 'responses' ? 'responses' : 'chat/completions'})`);
    console.log(`Scenario: ${isCode ? 'code (contract compliance — "bad code" proxy)' : 'recall (fact hallucination)'}`);
    console.log(`Thinking: ${opts.thinking}${opts.thinking === 'off' ? ' (disabled — mirrors extension default)' : ' (enabled)'}`);
    console.log(`Context window: ${opts.window.toLocaleString()} tokens | max output: ${opts.maxOutput.toLocaleString()} | available input: ~${availableInputTokens.toLocaleString()}`);
    if (isCode) {
        console.log(`Contracts: ${CODE_CONTRACTS.length} fake project conventions at the START of the conversation`);
        console.log(`Fill levels: ${opts.fills.join('%, ')}% of available input  (break = compliance < ${opts.threshold}%)`);
    } else {
        console.log(`Facts: ${anchors.length} (embedded at the START of the conversation, first to be truncated)`);
        console.log(`Fill levels: ${opts.fills.join('%, ')}% of available input`);
    }
    if (opts.dry) console.log('[DRY RUN — truncation stats only, no API calls]');
    console.log('');

    if (opts.findLimit) {
        await findLimit(opts, anchorMsgs, availableInputTokens);
        return;
    }

    if (opts.diag) {
        await runDiag(opts, anchorMsgs, availableInputTokens);
        return;
    }

    await runScan(opts, anchors, anchorMsgs, availableInputTokens, isCode, prefix);
}

/**
 * DIAGNOSTIC MODE (--diag): print the RAW model output so we can see what it
 * actually writes before trusting the compliance numbers.
 *
 *   A) contracts only, no filler  — pure instruction-following baseline
 *      (if compliance is ~0% HERE too, the test itself is the problem, not
 *      context length)
 *   B) one fill level (--diag-fill, default 10) — contracts buried under filler
 */
async function runDiag(opts, anchorMsgs, availableInputTokens) {
    const system = { role: 'system', content: SYSTEM_PROMPT };

    // A) baseline: contracts + task, nothing else (~3K tokens, full attention)
    const bare = [system, ...anchorMsgs];
    console.log(`[diag A] contracts only (~${estimateMessageTokens(bare).toLocaleString()} tok, ${bare.length} msgs) — baseline`);
    await diagProbe(opts, bare);

    // B) buried under filler at the requested fill level
    const { messages: raw } = buildConversation(opts.diagFill, anchorMsgs, opts.window, opts.maxOutput);
    const truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
    const contractsInPrompt = truncated.filter(m => m.role === 'user' && /^CONTRACT_/.test(m.content)).length;
    console.log(`[diag B] fill ${opts.diagFill}% (~${estimateMessageTokens(truncated).toLocaleString()} tok, ${truncated.length} msgs) — contracts present: ${contractsInPrompt}/${CODE_CONTRACTS.length}`);
    await diagProbe(opts, truncated);
}

async function diagProbe(opts, prompt) {
    const p = [...prompt];
    if (p.length && p[p.length - 1].role === 'tool') {
        p.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
    }
    p.push({ role: 'user', content: CODE_TASKS[0] });
    const res = await ask(p, opts.key, opts.model, 2000, opts.api, opts.thinking);
    const text = (res.text || '').trim();
    console.log('  --- RAW OUTPUT ---');
    console.log(text);
    console.log('  --- END RAW (length ' + text.length + ') ---');
    if (res.usage) console.log('  usage:', JSON.stringify(res.usage));
    const grades = gradeCode(text, CODE_CONTRACTS);
    const sat = grades.filter(g => g.satisfied).length;
    console.log(`  compliance: ${Math.round((sat / CODE_CONTRACTS.length) * 100)}% (${sat}/${CODE_CONTRACTS.length})`);
    grades.forEach(g => console.log(`    ${g.satisfied ? 'OK  ' : 'MISS'} ${g.name}${g.violated ? '  (VIOLATION: used forbidden pattern)' : ''}`));
    console.log('');
}

/**
 * Probe code quality at one fill level: build the conversation, apply the
 * extension's truncation, then ask `tasksPerProbe` code tasks and grade them
 * against the contracts. Returns mean compliance (%).
 */
async function probeCodeQuality(opts, anchorMsgs, availableInputTokens, fillPct) {
    const { messages: raw } = buildConversation(fillPct, anchorMsgs, opts.window, opts.maxOutput);
    const truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
    const prompt = [...truncated];
    if (prompt.length && prompt[prompt.length - 1].role === 'tool') {
        prompt.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
    }
    const results = [];
    for (let t = 0; t < opts.tasksPerProbe; t++) {
        const question = { role: 'user', content: CODE_TASKS[t % CODE_TASKS.length] };
        let answer = '', err = null;
        let usage;
        try {
            const res = await ask([...prompt, question], opts.key, opts.model, 1600, opts.api, opts.thinking);
            answer = (res.text || '').trim();
            usage = res.usage;
        } catch (e) {
            err = e instanceof Error ? e.message : String(e);
        }
        if (!answer && !err) {
            // Empty visible output — usually thinking mode ate the budget.
            const reason = usage?.output_tokens_details?.reasoning_tokens;
            console.warn(`  ⚠ EMPTY response (task ${t + 1}) — reasoning_tokens=${reason ?? 'n/a'}. ` +
                `If you did not pass --thinking=off, thinking is burning the output budget.`);
        }
        const grades = gradeCode(answer, CODE_CONTRACTS);
        const satisfied = grades.filter(g => g.satisfied).length;
        results.push({
            compliance: Math.round((satisfied / CODE_CONTRACTS.length) * 100),
            grades,
            answer,
            err,
            usage,
        });
    }
    const mean = Math.round(results.reduce((s, r) => s + r.compliance, 0) / results.length);
    const realInputTokens = results.reduce((mx, r) => Math.max(mx, r.usage?.input_tokens ?? 0), 0);
    return { fillPct, results, meanCompliance: mean, realInputTokens };
}

/**
 * Scan fill levels for the code-quality break point, then refine with one
 * bisection probe. Prints the NEW LIMIT for this model.
 */
async function findLimit(opts, anchorMsgs, availableInputTokens) {
    const coarse = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
    console.log(`Scanning ${coarse.length} fill levels of a ${opts.window.toLocaleString()} token window for the code-quality break point...`);
    console.log(`  Break = compliance below ${opts.threshold}%. Each level: ${opts.tasksPerProbe} code task(s).${opts.dry ? '  [DRY — truncation levels only]' : ''}`);
    console.log('');

    if (opts.dry) {
        for (const fillPct of coarse) {
            const { messages: raw } = buildConversation(fillPct, anchorMsgs, opts.window, opts.maxOutput);
            const rawTokens = estimateMessageTokens(raw);
            const truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
            const survived = survivingAnchorIndexes(truncated, 'CONTRACT');
            const tok = Math.round((availableInputTokens * fillPct) / 100);
            console.log(`  fill ${String(fillPct).padStart(3)}% → ~${tok.toLocaleString()} tok  (contracts kept: ${survived.size}/${CODE_CONTRACTS.length})`);
        }
        console.log('');
        console.log('(dry) run without --dry to measure actual code compliance at these levels.');
        return;
    }

    let lastGood = null;       // last fill% at/above threshold
    let firstBad = null;       // first fill% that truly degraded (real answers, low compliance)
    let ceilingFill = null;    // first fill% where the API rejected (context overflow)
    let lastGoodReal = 0;      // real input tokens at lastGood
    let lastGoodTok = 0;
    for (const fillPct of coarse) {
        const probe = await probeCodeQuality(opts, anchorMsgs, availableInputTokens, fillPct);
        const tok = Math.round((availableInputTokens * fillPct) / 100);
        const errs = probe.results.filter(r => r.err);
        const allErrored = errs.length === probe.results.length;
        const real = probe.realInputTokens ? `  (real input: ${probe.realInputTokens.toLocaleString()} tok)` : '';

        if (allErrored) {
            // Context overflow — real tokens exceeded the model's hard limit.
            console.log(`  ⚠ CEILING fill ${String(fillPct).padStart(3)}% (~${tok.toLocaleString()} tok) — API rejected: real tokens exceeded the 1,048,576 context limit. Stopping (higher fills only get worse).`);
            ceilingFill = fillPct;
            break;
        }

        const flag = probe.meanCompliance >= opts.threshold ? 'OK ' : 'BAD';
        console.log(`  ${flag} fill ${String(fillPct).padStart(3)}% (~${tok.toLocaleString()} tok)  compliance ${probe.meanCompliance}%${real}`);
        if (errs.length) console.log(`       ⚠ partial API error(s): ${errs.map(r => r.err).join(' | ')}`);
        if (probe.meanCompliance >= opts.threshold) {
            lastGood = fillPct;
            lastGoodReal = probe.realInputTokens;
            lastGoodTok = tok;
        } else if (firstBad === null) {
            firstBad = fillPct;
        }
    }

    console.log('');
    console.log(BAR);
    if (lastGood === null) {
        console.log(`Even the smallest level degraded (< ${opts.threshold}%). The contracts may be too hard — try --threshold lower or --tasks higher.`);
        return;
    }
    if (firstBad === null) {
        // No real quality degradation at any level we could measure.
        if (ceilingFill !== null) {
            console.log(`No code-quality degradation observed up to the API's context ceiling.`);
            console.log(`NEW LIMIT (${opts.model}): the FULL usable window — code quality held through ~${lastGoodReal.toLocaleString()} real tokens (${lastGood}% estimated fill).`);
            console.log(`Hard ceiling: the model's 1,048,576-token context. Beyond it the API returns HTTP 400 — that is a context ceiling, not a quality drop.`);
        } else {
            const tok = Math.round((availableInputTokens * 99) / 100);
            console.log(`No break point up to ~${tok.toLocaleString()} tokens — compliance stayed ≥ ${opts.threshold}% everywhere.`);
            console.log(`NEW LIMIT: at least ~${tok.toLocaleString()} tokens (the full window held up).`);
        }
        return;
    }

    // Real degradation found → refine with one bisection probe.
    const mid = Math.round((lastGood + firstBad) / 2);
    const probe = await probeCodeQuality(opts, anchorMsgs, availableInputTokens, mid);
    const tokMid = Math.round((availableInputTokens * mid) / 100);
    const errs = probe.results.filter(r => r.err);
    let flag;
    if (errs.length === probe.results.length) {
        flag = 'CEILING';
    } else {
        flag = probe.meanCompliance >= opts.threshold ? 'OK' : 'BAD';
    }
    const real = probe.realInputTokens ? `  (real input: ${probe.realInputTokens.toLocaleString()} tok)` : '';
    console.log(`  refinement at fill ${mid}% (~${tokMid.toLocaleString()} tok): compliance ${probe.meanCompliance}% → ${flag}${real}`);
    if (errs.length) console.log(`       ⚠ API error(s): ${errs.map(r => r.err).join(' | ')}`);
    const refinedGood = flag === 'OK' ? mid : lastGood;
    const refinedBad = flag === 'OK' ? firstBad : mid;

    const limitTok = Math.round((availableInputTokens * refinedGood) / 100);
    const badTok = Math.round((availableInputTokens * refinedBad) / 100);
    console.log('');
    console.log(BAR);
    console.log(`NEW LIMIT (${opts.model}):`);
    console.log(`  code quality holds up to ~${limitTok.toLocaleString()} tokens (${refinedGood}% fill)`);
    console.log(`  degrades by ~${badTok.toLocaleString()} tokens (${refinedBad}% fill)`);
    if (ceilingFill !== null) {
        console.log(`  (note: the level at ${ceilingFill}%+ was the API's context ceiling (HTTP 400), not a quality drop.)`);
    }
    console.log('');
    console.log('Practical advice: keep agentic sessions under the limit; past it, prefer');
    console.log('fresh sessions, grep/ripgrep lookups, and compaction over full-context recall.');
}

/**
 * Per-level scan (no auto-limit detection) with scenario-aware summaries.
 */
async function runScan(opts, anchors, anchorMsgs, availableInputTokens, isCode, prefix) {
    const report = [];

    for (const fillPct of opts.fills) {
        const { messages: raw } = buildConversation(fillPct, anchorMsgs, opts.window, opts.maxOutput);
        const rawTokens = estimateMessageTokens(raw);
        const truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
        const sentTokens = estimateMessageTokens(truncated);
        const actualFill = Math.round((rawTokens / availableInputTokens) * 100);
        const survived = survivingAnchorIndexes(truncated, prefix);
        const droppedIdx = anchors.map((_, i) => i).filter(i => !survived.has(i));
        const inWindowIdx = anchors.map((_, i) => i).filter(i => survived.has(i));

        const row = { fillPct: actualFill, sentTokens, inWindow: inWindowIdx, dropped: droppedIdx, results: {} };

        console.log(BAR);
        console.log(`Fill: ${actualFill}%  |  raw ~${rawTokens.toLocaleString()} tok  →  sent ~${sentTokens.toLocaleString()} tok  |  ${prefix}s in window: ${inWindowIdx.length}/${anchors.length}${droppedIdx.length ? `  ⚠ dropped: ${droppedIdx.length}` : ''}`);

        if (opts.dry) {
            if (droppedIdx.length) console.log(`  (dry) would drop ${prefix.toLowerCase()}s #${droppedIdx.join(', ')}`);
            report.push(row);
            continue;
        }

        if (isCode) {
            const probe = await probeCodeQuality(opts, anchorMsgs, availableInputTokens, fillPct);
            row.results.code = probe;
            const issues = new Set();
            probe.results.forEach((r, t) => {
                r.grades.forEach(g => {
                    if (!g.satisfied && g.violated) issues.add(`${g.name} (task ${t + 1}: used forbidden pattern)`);
                    else if (!g.satisfied) issues.add(`${g.name} (task ${t + 1}: omitted)`);
                });
            });
            console.log(`  compliance: ${probe.meanCompliance}% across ${opts.tasksPerProbe} task(s)`);
            if (issues.size) console.log(`  ⚠ ${[...issues].join(' | ')}`);
        } else {
            // Recall path: query each fact (in-window AND dropped).
            const prompt = [...truncated];
            if (prompt.length && prompt[prompt.length - 1].role === 'tool') {
                prompt.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
            }
            for (const idx of [...inWindowIdx, ...droppedIdx]) {
                const f = anchors[idx];
                const question = { role: 'user', content: `${f.q}\n(Answer from the conversation above only. If it is not there, say you do not have that information.)` };
                let grade, answer;
                try {
                    const res = await ask([...prompt, question], opts.key, opts.model, 256, opts.api, opts.thinking);
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
        }
        report.push(row);
    }

    // ── Summary ──
    console.log('');
    console.log(BAR);
    if (isCode) {
        console.log('SUMMARY — code quality vs context fill (conventions embedded at conversation START)');
        console.log(`${'fill%'.padEnd(8)}${'~tokens'.padEnd(14)}${'compliance'.padEnd(12)}status`);
        for (const row of report) {
            const c = row.results.code?.meanCompliance;
            const status = c === undefined ? '—' : (c >= opts.threshold ? 'OK' : '⚠ degrading');
            console.log(`${String(row.fillPct).padEnd(8)}${row.sentTokens.toLocaleString().padEnd(14)}${String(c ?? '-').padEnd(12)}${status}`);
        }
        const deg = report.filter(r => r.results.code && r.results.code.meanCompliance < opts.threshold);
        if (deg.length) {
            const first = deg[0];
            console.log('');
            console.log(`BREAK POINT: first degradation at ~${first.sentTokens.toLocaleString()} tokens (${first.fillPct}% fill, compliance ${first.results.code.meanCompliance}%).`);
            console.log('Run with --find-limit for a refined estimate.');
        } else {
            console.log('');
            console.log(`No degradation observed up to the highest fill tested (compliance ≥ ${opts.threshold}% everywhere). Try --find-limit.`);
        }
    } else {
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
    }

    if (opts.json) {
        console.log('\nJSON_REPORT_BEGIN');
        console.log(JSON.stringify(report.map(r => ({
            fillPct: r.fillPct,
            sentTokens: r.sentTokens,
            contractsDropped: r.dropped.length,
            ...(r.results.code
                ? { compliance: r.results.code.meanCompliance }
                : { grades: Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, v.grade])) }),
        })), null, 2));
        console.log('JSON_REPORT_END');
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
