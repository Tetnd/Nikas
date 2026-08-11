// Tests the FIXED truncation logic (matches src/provider.ts after the fix).
// Ensures the resulting sequence is always valid for DeepSeek.
// NOTE: estimator is content-aware (per-shape char/token ratios) + adaptively
// calibrated from real API usage — mirrors src/provider.ts.
const PROSE_CHARS_PER_TOKEN = 4.0;
const STRUCTURED_CHARS_PER_TOKEN = 2.5;
const BASE64_CHARS_PER_TOKEN = 1.4;
const STRUCTURED_PUNCT_THRESHOLD = 0.15;
const BASE64_RUN_RE = /[A-Za-z0-9+/=]{32,}/g;
const PUNCT_RE = /[^\p{L}\p{N}\s_]/gu;

const ADAPTIVE_ALPHA = 0.25;
const ADAPTIVE_FLOOR = 0.8;
const ADAPTIVE_CEIL = 4.0;
const DEFAULT_CALIBRATION = 1.1;
const CALIBRATION_CACHE_MAX = 32;
// Per-session adaptive calibration (mirrors src/provider.ts).
const calibrationBySession = new Map();
function getCalibration(sessionKey) {
    if (sessionKey) { const v = calibrationBySession.get(sessionKey); if (v !== undefined) return v; }
    return DEFAULT_CALIBRATION;
}

function estimateSegmentTokens(segment) {
    if (!segment) return 0;
    const punctCount = (segment.match(PUNCT_RE) || []).length;
    const punctDensity = punctCount / segment.length;
    const charsPerToken = punctDensity >= STRUCTURED_PUNCT_THRESHOLD ? STRUCTURED_CHARS_PER_TOKEN : PROSE_CHARS_PER_TOKEN;
    return Math.ceil(segment.length / charsPerToken);
}

function estimateTextTokens(text) {
    if (!text) return 0;
    let total = 0;
    let last = 0;
    let m;
    BASE64_RUN_RE.lastIndex = 0;
    while ((m = BASE64_RUN_RE.exec(text)) !== null) {
        if (m.index > last) total += estimateSegmentTokens(text.slice(last, m.index));
        total += Math.ceil(m[0].length / BASE64_CHARS_PER_TOKEN);
        last = m.index + m[0].length;
    }
    if (last < text.length) total += estimateSegmentTokens(text.slice(last));
    return total;
}

function applyCalibration(raw, sessionKey) { return Math.ceil(raw * getCalibration(sessionKey)); }

function observeCalibration(sessionKey, realTokens, estimatedTokens) {
    if (!sessionKey) return;
    if (!Number.isFinite(realTokens) || !Number.isFinite(estimatedTokens)) return;
    if (realTokens <= 0 || estimatedTokens <= 0) return;
    const ratio = realTokens / estimatedTokens;
    if (ratio <= 0 || ratio > 12) return;
    const next = Math.min(ADAPTIVE_CEIL, Math.max(ADAPTIVE_FLOOR, ADAPTIVE_ALPHA * ratio + (1 - ADAPTIVE_ALPHA) * getCalibration(sessionKey)));
    calibrationBySession.set(sessionKey, next);
    if (calibrationBySession.size > CALIBRATION_CACHE_MAX) {
        const oldest = calibrationBySession.keys().next().value;
        if (oldest !== undefined) calibrationBySession.delete(oldest);
    }
}

function estimateMessageTokens(messages, sessionKey) {
    let total = 0;
    for (const msg of messages) {
        total += 8;
        if (typeof msg.content === 'string') {
            total += estimateTextTokens(msg.content);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text) total += estimateTextTokens(part.text);
                else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
                    const url = part.image_url.url;
                    const comma = url.indexOf(',');
                    const payload = comma >= 0 ? url.slice(comma + 1) : url;
                    total += estimateTextTokens(payload);
                }
            }
        }
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                total += estimateTextTokens(tc.function.name);
                total += estimateTextTokens(tc.function.arguments);
            }
        }
        if (msg.reasoning_content) total += estimateTextTokens(msg.reasoning_content);
    }
    return applyCalibration(total, sessionKey);
}

// ── FIXED logic (copy of src/provider.ts after repair) ──
function truncateMessagesToContextWindow(messages, maxContextTokens, maxOutputTokens) {
    const API_TOTAL_CEILING = 1048576;
    const API_CEILING_SAFETY = 65536;
    const availableInputTokens = Math.max(
        1024,
        Math.min(
            maxContextTokens - maxOutputTokens - 1024,
            API_TOTAL_CEILING - maxOutputTokens - API_CEILING_SAFETY
        )
    );

    const systemMessages = [];
    const otherMessages = [];
    for (const msg of messages) {
        if (msg.role === 'system' && systemMessages.length === 0) systemMessages.push(msg);
        else otherMessages.push(msg);
    }

    const estimatedTokens = estimateMessageTokens(messages);
    if (estimatedTokens <= availableInputTokens) {
        // Everything fits — still repair (conversation may end mid-tool-call),
        // then guarantee a user message survives.
        return ensureUserMessage(repairTruncatedSequence(systemMessages, otherMessages), otherMessages);
    }

    const keptMessages = [];
    const hardInputLimit = API_TOTAL_CEILING - maxOutputTokens - API_CEILING_SAFETY;
    let tokenBudget = availableInputTokens - estimateMessageTokens(systemMessages);
    let oversizedKept = false;

    for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgTokens = estimateMessageTokens([msg]);
        if (msgTokens <= tokenBudget) {
            keptMessages.unshift(msg);
            tokenBudget -= msgTokens;
        } else if (keptMessages.length === 0) {
            // Oversized newest message — keep it (empty window is worse) unless
            // it exceeds the API's hard ceiling. Plus its tool_calls caller and
            // the nearest preceding user turn (else repair strips it all).
            if (msgTokens <= hardInputLimit) {
                keptMessages.unshift(msg);
                oversizedKept = true;
                tokenBudget = 0;
                if (msg.role === 'tool' && msg.tool_call_id) {
                    const caller = otherMessages[i - 1];
                    if (caller && caller.role === 'assistant' && caller.tool_calls && caller.tool_calls.some(tc => tc.id === msg.tool_call_id)) {
                        keptMessages.unshift(caller);
                    }
                }
                const keptStart = otherMessages.length - keptMessages.length;
                for (let j = keptStart - 1; j >= 0; j--) {
                    if (otherMessages[j].role === 'user') {
                        keptMessages.unshift(otherMessages[j]);
                        break;
                    }
                }
            } else {
                break;
            }
        } else {
            break;
        }
    }

    return ensureUserMessage(repairTruncatedSequence(systemMessages, keptMessages), otherMessages);
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

function messageText(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter(p => p.type === 'text' && p.text)
            .map(p => p.text)
            .join(' ');
    }
    return '';
}

// ── FIX (2026-08-10 empty-input 400): never send a user-less window ──
// Mirrors ensureUserMessage in src/provider.ts. A pure tool-call window
// (or one whose user turns were all truncated) has no user message; the
// Responses path hoists system → instructions leaving input empty → HTTP 400
// "Input items array must not be empty". Re-inject the newest real user turn
// (or a placeholder) so the request is always valid.
function ensureUserMessage(seq, originalOthers) {
    if (seq.some(m => m.role === 'user' && messageText(m).trim() !== '')) return seq;
    const newestUser = [...originalOthers].reverse().find(m => m.role === 'user' && messageText(m).trim() !== '');
    const injected = newestUser ?? { role: 'user', content: 'Continue.' };
    const userIdx = seq.findIndex(m => m.role === 'user');
    if (userIdx >= 0) {
        const copy = [...seq];
        copy[userIdx] = { ...injected };
        return copy;
    }
    const firstNonSystem = seq.findIndex(m => m.role !== 'system');
    const copy = [...seq];
    if (firstNonSystem === -1) copy.push(injected);
    else copy.splice(firstNonSystem, 0, injected);
    return copy;
}

// ── Validation: DeepSeek constraints ──
function findDeepSeekIssues(messages) {
    const issues = [];
    if (messages.length === 0) { issues.push('EMPTY request'); return issues; }
    const first = messages[0];
    if (first.role !== 'system' && first.role !== 'user') {
        issues.push(`First message role is "${first.role}" — must be system/user`);
    }
    // Empty-input 400 regression guard (2026-08-10): no user message with
    // non-empty content → Responses API would receive inputItems=0 → HTTP 400.
    if (!messages.some(m => m.role === 'user' && messageText(m).trim() !== '')) {
        issues.push('NO user message with non-empty content (empty-input 400 risk)');
    }
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const prev = i > 0 ? messages[i - 1] : null;
        const next = i < messages.length - 1 ? messages[i + 1] : null;
        if (msg.role === 'tool') {
            // Scan BACK through the window for a caller with the same call_id
            // (an assistant turn with N tool_calls → N consecutive tool
            // results; only the first has the assistant directly before it).
            if (!msg.tool_call_id) {
                issues.push(`[${i}] tool result missing tool_call_id`);
            } else {
                const hasCaller = messages.slice(0, i).some(m =>
                    m.role === 'assistant' && m.tool_calls && m.tool_calls.some(tc => tc.id === msg.tool_call_id)
                );
                if (!hasCaller) {
                    issues.push(`[${i}] tool result without preceding assistant tool_calls (${msg.tool_call_id})`);
                }
            }
        }
        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && (!next || next.role !== 'tool')) {
            issues.push(`[${i}] assistant tool_calls dangling (results truncated): ${msg.tool_calls.map(t => t.id).join(',')}`);
        }
        if (msg.role === 'user' && prev?.role === 'user') {
            issues.push(`[${i}] two consecutive user messages`);
        }
    }
    return issues;
}

let failures = 0, safe = 0, scenarios = 0;

function testScenario(name, messages, maxContext, maxOutput) {
    scenarios++;
    const truncated = truncateMessagesToContextWindow(messages, maxContext, maxOutput);
    const issues = findDeepSeekIssues(truncated);
    if (issues.length > 0) {
        failures++;
        console.log(`❌ "${name}": ${issues.length} issue(s)`);
        for (const issue of issues) console.log(`    ${issue}`);
        console.log('    tail:', truncated.slice(-4).map(m => `[${m.role}]` + (m.tool_calls ? 'calls' : '') + (m.tool_call_id ? 'res' : '')).join(' '));
    } else {
        safe++;
        console.log(`✅ "${name}": OK (${truncated.length} msgs)`);
    }
}

// Scenario 1: conversation ends mid-tool-call (auto-compact trigger state)
{
    const m = [];
    m.push({ role: 'system', content: 'You are an assistant.' });
    for (let r = 0; r < 20; r++) {
        m.push({ role: 'user', content: `Question ${r} ` + 'x'.repeat(100) });
        m.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${r}`, type: 'function', function: { name: 'search', arguments: '{}' } }] });
        m.push({ role: 'tool', tool_call_id: `c${r}`, content: 'result ' + 'y'.repeat(150) });
        m.push({ role: 'assistant', content: 'Answer ' + 'z'.repeat(80) });
    }
    m.push({ role: 'user', content: 'One more question ' + 'q'.repeat(50) });
    m.push({ role: 'assistant', content: null, tool_calls: [{ id: 'last', type: 'function', function: { name: 'search', arguments: '{}' } }] });
    for (const ctx of [2048, 4096, 8192, 16384]) testScenario(`mid-tool-cut ctx=${ctx}`, m, ctx, 2048);
}

// Scenario 2: varied contexts with full tool rounds
{
    const m = [];
    m.push({ role: 'system', content: 'You are an assistant.' });
    for (let r = 0; r < 30; r++) {
        m.push({ role: 'user', content: `Question ${r} ` + 'x'.repeat(120) });
        m.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${r}`, type: 'function', function: { name: 'search', arguments: '{}' } }] });
        m.push({ role: 'tool', tool_call_id: `c${r}`, content: 'result ' + 'y'.repeat(180) });
        m.push({ role: 'assistant', content: 'Answer ' + 'z'.repeat(100) });
    }
    m.push({ role: 'user', content: 'Final question ' + 'q'.repeat(60) });
    for (const ctx of [3000, 5000, 6000, 8000, 10000, 12000, 20000, 40000]) testScenario(`varied ctx=${ctx}`, m, ctx, 2048);
}

// Scenario 3: huge single tool result
{
    const m = [];
    m.push({ role: 'system', content: 'You are an assistant.' });
    m.push({ role: 'user', content: 'Read the big file' });
    m.push({ role: 'assistant', content: null, tool_calls: [{ id: 'big', type: 'function', function: { name: 'readFile', arguments: '{}' } }] });
    m.push({ role: 'tool', tool_call_id: 'big', content: 'y'.repeat(50000) });
    m.push({ role: 'assistant', content: 'Here is a summary of what I read' });
    m.push({ role: 'user', content: 'Thanks!' });
    testScenario('huge-tool-result', m, 8192, 2048);
}

// Scenario 4: negative budget (maxTokens >= context - 1024)
{
    const m = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello ' + 'x'.repeat(500) },
        { role: 'assistant', content: 'hi' },
    ];
    testScenario('negative-budget', m, 8192, 40000); // 8192 - 40000 - 1024 < 0
}

// Scenario 5: no system message, conversation ends mid-tool
{
    const m = [];
    for (let r = 0; r < 15; r++) {
        m.push({ role: 'user', content: `Q${r} ` + 'x'.repeat(90) });
        m.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${r}`, type: 'function', function: { name: 'f', arguments: '{}' } }] });
        m.push({ role: 'tool', tool_call_id: `c${r}`, content: 'r' + 'y'.repeat(120) });
        m.push({ role: 'assistant', content: 'A' + 'z'.repeat(60) });
    }
    m.push({ role: 'user', content: 'last question' });
    m.push({ role: 'assistant', content: null, tool_calls: [{ id: 'final', type: 'function', function: { name: 'f', arguments: '{}' } }] });
    testScenario('no-system mid-tool', m, 6000, 2048);
}

// Scenario 6: random fuzz — many random tool conversations
{
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let t = 0; t < 200; t++) {
        const m = [];
        if (rand() < 0.8) m.push({ role: 'system', content: 'sys ' + 's'.repeat(Math.floor(rand() * 200)) });
        const rounds = 2 + Math.floor(rand() * 25);
        for (let r = 0; r < rounds; r++) {
            m.push({ role: 'user', content: `Q${r} ` + 'x'.repeat(Math.floor(rand() * 300)) });
            // maybe a tool round, maybe not
            if (rand() < 0.6) {
                const callId = `c${r}`;
                m.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'f', arguments: '{}' } }] });
                m.push({ role: 'tool', tool_call_id: callId, content: 'res ' + 'y'.repeat(Math.floor(rand() * 400)) });
                m.push({ role: 'assistant', content: 'ans ' + 'z'.repeat(Math.floor(rand() * 200)) });
            } else {
                m.push({ role: 'assistant', content: 'plain ' + 'z'.repeat(Math.floor(rand() * 200)) });
            }
        }
        // 50% chance the conversation ends mid-tool-call
        if (rand() < 0.5) {
            m.push({ role: 'user', content: 'follow-up' });
            m.push({ role: 'assistant', content: null, tool_calls: [{ id: 'fx', type: 'function', function: { name: 'f', arguments: '{}' } }] });
        } else {
            m.push({ role: 'user', content: 'final ' + 'q'.repeat(Math.floor(rand() * 150)) });
        }
        const ctx = 2048 + Math.floor(rand() * 30000);
        const out = truncateMessagesToContextWindow(m, ctx, 1024 + Math.floor(rand() * 8000));
        const issues = findDeepSeekIssues(out);
        if (issues.length > 0) {
            failures++;
            console.log(`❌ fuzz#${t}: ctx=${ctx} ${issues.length} issue(s)`);
            for (const issue of issues) console.log(`    ${issue}`);
            console.log('    all roles:', out.map(x => x.role).join(','));
        } else {
            safe++;
        }
    }
}

console.log(`\n===== ${scenarios} targeted + 200 fuzz → ${safe} safe, ${failures} failing =====`);

// ── 7. Empty-input 400 regression (2026-08-10) ──
// A pure tool-call agent loop at ~105% fill truncated to a system-only
// window; the Responses path hoisted system → instructions, leaving input
// empty → HTTP 400 "Input items array must not be empty". ensureUserMessage
// must re-inject the newest real user turn (or a placeholder) so the request
// is always valid — and the retry loop can never repeat the same 400.
console.log('\n=== 7. Empty-input 400 regression (pure tool loop @ ~105% fill) ===');
{
    // Build the reported shape: system + empty initial user + pure tool loop,
    // grown past the 256K preset's available input budget.
    const m = [];
    m.push({ role: 'system', content: 'You are Nikas, an agentic coding assistant. '.repeat(80) });
    m.push({ role: 'user', content: '' }); // empty initial user (agent mode)
    let r = 0;
    while (estimateMessageTokens(m) < 257000) {
        const id = `call_${String(r).padStart(2, '0')}`;
        m.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: r % 2 ? 'read_file' : 'read_page', arguments: JSON.stringify({ path: '/x'.repeat(200) }) } }] });
        m.push({ role: 'tool', tool_call_id: id, content: (r % 2 ? 'Page ' : 'La ') + 'x'.repeat(6000) });
        r++;
    }
    const available = 262144 - 16384 - 1024;
    const fillPct = Math.round(estimateMessageTokens(m) / available * 100);
    console.log(`  conversation: ${m.length} msgs, ~${estimateMessageTokens(m).toLocaleString()} tok (~${fillPct}% of ${available.toLocaleString()})`);

    const out = truncateMessagesToContextWindow(m, 262144, 16384);
    const issues = findDeepSeekIssues(out);
    if (issues.length > 0) {
        failures++; console.log(`❌ scenario 7: ${issues.length} issue(s)`);
        for (const i of issues) console.log(`    ${i}`);
        console.log('    roles:', out.map(x => x.role).join(','));
    } else {
        safe++; console.log(`✅ scenario 7: OK (${out.length} msgs, roles: ${out.map(x => x.role).join(',')})`);
    }

    // Directly check the exact reported symptom: Responses input must be non-empty.
    const input = [];
    let instructions;
    for (const msg of out) {
        if (msg.role === 'system') { if (!instructions) instructions = messageText(msg); continue; }
        if (msg.role === 'user') { input.push({ type: 'message', role: 'user', content: messageText(msg) }); continue; }
        if (msg.role === 'assistant') {
            if (msg.reasoning_content) input.push({ type: 'reasoning_text', text: msg.reasoning_content });
            const t = messageText(msg);
            if (t) input.push({ type: 'message', role: 'assistant', content: t });
            if (msg.tool_calls) for (const tc of msg.tool_calls) input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
            continue;
        }
        if (msg.role === 'tool') input.push({ type: 'function_call_output', call_id: msg.tool_call_id, output: messageText(msg) });
    }
    if (input.length === 0) {
        failures++; console.log(`❌ scenario 7: Responses input still EMPTY (inputItems=0 → HTTP 400)`);
    } else {
        safe++; console.log(`✅ scenario 7: Responses input has ${input.length} item(s) — no empty-input 400`);
    }
}
{
    // Conversation FITS the window but is user-less (empty initial user + tool loop):
    // the non-truncating path must also repair it (fill the empty user in place).
    const m = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'res' },
    ];
    const out = truncateMessagesToContextWindow(m, 100000, 1024);
    const issues = findDeepSeekIssues(out);
    if (issues.length > 0) {
        failures++; console.log(`❌ fits-user-less: ${issues.join('; ')}`);
        console.log('    roles:', out.map(x => x.role).join(','));
    } else {
        safe++; console.log(`✅ fits-user-less: OK (${out.length} msgs, roles: ${out.map(x => x.role).join(',')})`);
    }
}

// ── 8. Coalescing consecutive user messages (messages.ts fix) ──
// DeepSeek merges consecutive user messages server-side, but a clean
// alternating sequence is better. Copilot's agent loop produces adjacent
// user messages (e.g. tool-result messages emit role:"user" text right
// before the next real user turn) — coalescing normalizes them once, in
// vscodeMessagesToDeepSeek, so validateMessageSequence stays quiet.
console.log('\n=== 7. Coalesce consecutive user messages ===');
function mergeUserContent(a, b) {
    const textParts = [];
    const structured = [];
    const collect = (c) => {
        if (typeof c === 'string') { if (c.trim()) textParts.push(c); }
        else if (Array.isArray(c)) {
            for (const p of c) {
                if (p.type === 'text') { if (p.text && p.text.trim()) textParts.push(p.text); }
                else structured.push(p);
            }
        }
    };
    collect(a); collect(b);
    if (structured.length === 0) return textParts.join('\n');
    const merged = [];
    if (textParts.length > 0) merged.push({ type: 'text', text: textParts.join('\n') });
    merged.push(...structured);
    return merged;
}
function coalesceConsecutiveUserMessages(messages) {
    if (messages.length < 2) return messages;
    const result = [];
    for (const msg of messages) {
        const prev = result[result.length - 1];
        if (prev && prev.role === 'user' && msg.role === 'user') {
            prev.content = mergeUserContent(prev.content, msg.content);
            if (!prev.name && msg.name) prev.name = msg.name;
        } else {
            result.push({ ...msg });
        }
    }
    return result;
}
let cPass = 0, cFail = 0;
function ccheck(name, cond, detail) {
    if (cond) { cPass++; console.log(`  PASS ${name}`); }
    else { cFail++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

{
    // string + string → single string
    const out = coalesceConsecutiveUserMessages([
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
    ]);
    ccheck('two string users → one message', out.length === 1 && out[0].role === 'user');
    ccheck('strings joined with newline', out[0].content === 'first\nsecond', JSON.stringify(out[0].content));
}
{
    // three consecutive users → one
    const out = coalesceConsecutiveUserMessages([
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'user', content: 'c' },
    ]);
    ccheck('three users → one', out.length === 1 && out[0].content === 'a\nb\nc', JSON.stringify(out));
}
{
    // non-user messages break the run and are preserved
    const out = coalesceConsecutiveUserMessages([
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'user', content: 'u3' },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    ]);
    const roles = out.map(m => m.role);
    ccheck('roles preserved/merged', JSON.stringify(roles) === JSON.stringify(['user', 'assistant', 'user', 'tool']), JSON.stringify(roles));
    ccheck('u2+u3 merged', out[2].content === 'u2\nu3', JSON.stringify(out[2].content));
}
{
    // structured content (image_url) merged with text
    const out = coalesceConsecutiveUserMessages([
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
        { role: 'user', content: 'what is this' },
    ]);
    ccheck('structured+string merged into one user', out.length === 1);
    ccheck('image part preserved', Array.isArray(out[0].content) && out[0].content.some(p => p.type === 'image_url'));
    ccheck('text inline in structured merge', Array.isArray(out[0].content) && out[0].content.some(p => p.type === 'text' && p.text === 'what is this'), JSON.stringify(out[0].content));
}
{
    // does not mutate the caller's array
    const input = [
        { role: 'user', content: 'x' },
        { role: 'user', content: 'y' },
    ];
    const out = coalesceConsecutiveUserMessages(input);
    ccheck('output is a new array', out !== input);
    ccheck('input not mutated', input.length === 2 && input[0].content === 'x', JSON.stringify(input));
}
{
    // realistic agent loop: tool-result user text adjacent to next user turn
    const seq = coalesceConsecutiveUserMessages([
        { role: 'user', content: 'Find the file' },                                          // real user turn
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'no matches' },
        { role: 'user', content: 'please continue' },                                        // text alongside tool result
        { role: 'user', content: 'Actually try a different search' },                        // next real user turn
    ]);
    const issues = findDeepSeekIssues(seq);
    ccheck('agent-loop sequence has zero issues after coalescing', issues.length === 0, JSON.stringify(issues));
    const userIdx = seq.map(m => m.role).indexOf('user');
    ccheck('adjacent users merged into one', seq[userIdx + 1]?.role === 'assistant', JSON.stringify(seq.map(m => m.role)));
    ccheck('tool result preserved', seq.some(m => m.role === 'tool' && m.tool_call_id === 'c1'));
}
{
    // empty + text edge: merging never introduces an empty-content user
    const out = coalesceConsecutiveUserMessages([
        { role: 'user', content: '  ' },
        { role: 'user', content: 'real text' },
    ]);
    ccheck('whitespace user merged away', out.length === 1 && out[0].content === 'real text', JSON.stringify(out));
}
{
    // system-first sequence untouched
    const out = coalesceConsecutiveUserMessages([
        { role: 'system', content: 'You are an assistant.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
    ]);
    ccheck('system/assistant not merged', out.length === 3 && out[0].role === 'system' && out[1].role === 'user' && out[2].role === 'assistant');
}
console.log(`  → ${cPass} coalescing checks passed, ${cFail} failed`);
failures += cFail;

// ── 9. Content-aware estimator ──
// The old single "chars/4 × 1.4" estimate overcounted prose (~2.86 chars/token
// vs real ~4) and undercounted code/JSON/base64 — so truncation fired at the
// wrong time and silently evicted early context ("the model loses it"). The
// new estimator is per-shape (prose / structured / base64) + adaptively
// calibrated from real API usage.
console.log('\n=== 9. Content-aware estimator ===');
{
    const check = (name, cond, detail) => {
        if (cond) { safe++; console.log(`  PASS ${name}`); }
        else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
    };

    // base64 runs counted at ~1.4 chars/token (NOT zero — was invisible before)
    const b64 = 'A'.repeat(4096);
    const t1 = estimateTextTokens('data:image/png;base64,' + b64);
    check('base64 payload counted (not zero)', t1 > 1000, `got ${t1}`);
    check('base64 density ~1.4 chars/token', t1 >= 2900 && t1 <= 3100, `got ${t1}`);

    // prose at ~4 chars/token
    const prose = 'word '.repeat(800); // 4000 chars
    const tp = estimateTextTokens(prose);
    check('prose ~4 chars/token', tp >= 900 && tp <= 1100, `got ${tp}`);

    // JSON (with long value runs) is denser than equal-length prose
    const json = JSON.stringify({ a: 'x'.repeat(2000), b: 'y'.repeat(2000) });
    const tj = estimateTextTokens(json);
    const proseEq = estimateTextTokens('word '.repeat(804));
    check('JSON denser than prose (more tokens per char)', tj > proseEq + 500, `json=${tj} prose=${proseEq}`);

    // image_url payload counted in the message estimator
    const imgMsg = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] }];
    const withImg = estimateMessageTokens(imgMsg);
    const without = estimateMessageTokens([{ role: 'user', content: '' }]);
    check('image_url payload counted in message estimate', withImg > without + 1000, `with=${withImg} without=${without}`);

    // Hebrew prose classified as prose (Unicode-aware punctuation detection)
    const hebrew = 'שלום עולם זהו מבחן פשוט לבדיקה '.repeat(100);
    const th = estimateTextTokens(hebrew);
    check('Hebrew prose ~4 chars/token (not misclassified as code)', th >= 600 && th <= 950, `got ${th}`);

    // code/JSON punctuation-dense → structured density
    const code = 'function foo() { return bar.baz(42); } '.repeat(20); // 780 chars
    const tc = estimateTextTokens(code);
    const proseSameLen = estimateTextTokens('word '.repeat(156));
    check('code denser than equal-length prose', tc > proseSameLen, `code=${tc} prose=${proseSameLen}`);
}

// ── 10. Validator no longer false-positives ──
// Two checks flagged every real agent request before: (a) the 2nd+ tool
// result after a multi-call assistant turn, (b) assistant tool_calls with a
// narration content string. Real orphans must still be caught.
console.log('\n=== 10. Validator false-positive fixes ===');
{
    const check = (name, cond, detail) => {
        if (cond) { safe++; console.log(`  PASS ${name}`); }
        else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
    };

    // assistant with 2 tool_calls → 2 consecutive tool results
    const seq = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'read two files' },
        { role: 'assistant', content: null, tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'read_page', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'c1', content: 'file one' },
        { role: 'tool', tool_call_id: 'c2', content: 'page two' },
        { role: 'assistant', content: 'done' },
    ];
    const issues = findDeepSeekIssues(seq);
    check('consecutive tool results not flagged (caller 2 slots back)', issues.length === 0, JSON.stringify(issues));

    // assistant tool_calls WITH narration content string (Copilot behavior)
    const seq2 = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: 'Let me look this up.', tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'c1', content: 'res' },
    ];
    const issues2 = findDeepSeekIssues(seq2);
    check('content string + tool_calls not flagged', issues2.length === 0, JSON.stringify(issues2));

    // a REAL orphaned tool result (caller absent) is still flagged
    const seq3 = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'ghost', content: 'orphan' },
    ];
    const issues3 = findDeepSeekIssues(seq3);
    check('real orphaned tool result still flagged', issues3.length > 0, JSON.stringify(issues3));
}

// ── 11. Oversized newest message kept (not an empty window) ──
// A single huge tool result (read_file/read_page dump) used to evict the whole
// conversation: keep-newest hit the oversized message, broke, and the model saw
// nothing. Now the oversized message (plus its caller + nearest user) is kept
// as long as it fits under the API hard ceiling.
console.log('\n=== 11. Oversized newest message kept ===');
{
    const check = (name, cond, detail) => {
        if (cond) { safe++; console.log(`  PASS ${name}`); }
        else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
    };
    const m = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'read the big file' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'big', type: 'function', function: { name: 'readFile', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'big', content: 'x'.repeat(200000) }, // ~143K est tokens — over the 13K window
    ];
    const out = truncateMessagesToContextWindow(m, 16384, 2048);
    const issues = findDeepSeekIssues(out);
    const hasResult = out.some(x => x.role === 'tool' && x.tool_call_id === 'big');
    check('oversized newest tool result kept (not empty window)', hasResult, JSON.stringify(out.map(x => x.role)));
    check('oversized kept sequence valid', issues.length === 0, JSON.stringify(issues));
    check('nearest user preserved before the tool group', out.some(x => x.role === 'user' && messageText(x).includes('read the big file')), JSON.stringify(out.map(x => x.role)));

    // a message over the HARD ceiling is still dropped
    const m2 = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'read the giant file' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'g', type: 'function', function: { name: 'readFile', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'g', content: 'x'.repeat(3000000) }, // ~2.1M est tokens — over the ~981K hard limit
    ];
    const out2 = truncateMessagesToContextWindow(m2, 16384, 2048);
    const issues2 = findDeepSeekIssues(out2);
    const hasGiant = out2.some(x => x.role === 'tool' && x.tool_call_id === 'g');
    check('over-hard-ceiling message dropped', !hasGiant, JSON.stringify(out2.map(x => x.role)));
    check('dropped-giant sequence still valid', issues2.length === 0, JSON.stringify(issues2));
}

// ── 12. Adaptive calibration from real API usage ──
console.log('\n=== 12. Adaptive calibration (per-session) ===');
{
    const check = (name, cond, detail) => {
        if (cond) { safe++; console.log(`  PASS ${name}`); }
        else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
    };
    const S = 'sessionA';
    calibrationBySession.clear();
    calibrationBySession.set(S, 1.0);
    observeCalibration(S, 1000, 500); // real/est = 2.0
    check('calibration moves toward observed ratio', getCalibration(S) > 1.0, `got ${getCalibration(S)}`);
    check('calibration bounded', getCalibration(S) >= ADAPTIVE_FLOOR && getCalibration(S) <= ADAPTIVE_CEIL, `got ${getCalibration(S)}`);
    for (let k = 0; k < 50; k++) observeCalibration(S, 3000, 1000); // ratio 3.0
    check('calibration converges toward 3.0', getCalibration(S) >= 2.95 && getCalibration(S) <= 3.05, `got ${getCalibration(S)}`);
    check('applyCalibration reflects factor', applyCalibration(1000, S) === 3000, `got ${applyCalibration(1000, S)}`);
    // Cross-session isolation: session B must NOT inherit session A's factor.
    check('new session uses default factor', getCalibration('sessionB') === DEFAULT_CALIBRATION, `got ${getCalibration('sessionB')}`);
    observeCalibration('sessionB', 1000, 500); // session B ratio 2.0
    check('session B factor independent of A', getCalibration('sessionB') > DEFAULT_CALIBRATION && getCalibration('sessionB') < 3.0, `got ${getCalibration('sessionB')}`);
    check('session A unaffected by B', getCalibration(S) >= 2.95 && getCalibration(S) <= 3.05, `got ${getCalibration(S)}`);
    check('applyCalibration no-key uses default', applyCalibration(1000) === Math.ceil(1000 * DEFAULT_CALIBRATION), `got ${applyCalibration(1000)}`);
    // garbage samples rejected (per session)
    calibrationBySession.set('sessionC', DEFAULT_CALIBRATION);
    observeCalibration('sessionC', 0, 0);
    observeCalibration('sessionC', -5, 10);
    observeCalibration('sessionC', 100, -1);
    observeCalibration('sessionC', NaN, 100);
    check('garbage samples rejected', getCalibration('sessionC') === DEFAULT_CALIBRATION, `got ${getCalibration('sessionC')}`);
    // observation without a session key is dropped (no global corruption)
    const before = getCalibration('sessionD');
    observeCalibration(undefined, 10000, 1000);
    check('no-key observation is dropped', getCalibration('sessionD') === before, `got ${getCalibration('sessionD')}`);
}

// ── 13. API ceiling clamp ──
console.log('\n=== 13. API ceiling clamp ===');
{
    const check = (name, cond, detail) => {
        if (cond) { safe++; console.log(`  PASS ${name}`); }
        else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
    };
    const avail = Math.max(1024, Math.min(5000000 - 16384 - 1024, 1048576 - 16384 - 65536));
    check('absurd window clamps to ~981K (not 5M)', avail === 1048576 - 16384 - 65536, `avail=${avail}`);
    const m = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello ' + 'x'.repeat(5000) },
        { role: 'assistant', content: 'hi' },
    ];
    const out = truncateMessagesToContextWindow(m, 5000000, 16384);
    const issues = findDeepSeekIssues(out);
    check('clamped request still valid', issues.length === 0, JSON.stringify(issues));
}

// ── 14. Compaction plan (reliability limit) ──
// Mirrors the pure parts of maybeCompactContext in src/provider.ts: keep the
// newest content up to the reliability budget, compact the old block into a
// session-memory summary, snap the boundary to a user turn, and keep the
// resulting sequence valid. (The model call + cache live in compact.ts.)
console.log('\n=== 14. Compaction plan (reliability limit) ===');
{
    const MIN_COMPACT_BLOCK = 8;
    const SUMMARY_MAX_TOKENS = 4096;
    const REUSE_GROWTH_THRESHOLD = 16;

    function planCompaction(messages, reliabilityLimit, availableInput) {
        // Mirrors provider.ts: the compacted result must fit BOTH the
        // reliability limit AND the window's available input; cap at the
        // smaller so auto-compact fires on small windows too (not just big
        // ones where the limit is the binding constraint).
        if (availableInput === undefined) availableInput = Infinity;
        const budgetCap = Math.min(reliabilityLimit, availableInput);
        const estimated = estimateMessageTokens(messages);
        if (estimated <= budgetCap) return null;
        const system = messages.length > 0 && messages[0].role === 'system' ? [messages[0]] : [];
        const others = messages.slice(system.length);
        const summaryOverhead = SUMMARY_MAX_TOKENS + 1024;
        const keepBudget = budgetCap - estimateMessageTokens(system) - summaryOverhead;
        if (keepBudget < 1024) return null;
        // Aggregate-based split landing on a USER-TURN boundary: walk the user
        // boundaries from the oldest, pick the smallest old block whose kept
        // suffix fits budget (measured with the same aggregate estimator). This
        // guarantees an old block whenever estimated > budget and never splits
        // a tool-call/tool-result pair.
        const userBoundaries = [];
        for (let i = 0; i < others.length; i++) if (others[i].role === 'user') userBoundaries.push(i);
        let splitIdx = -1;
        for (const i of userBoundaries) {
            if (estimateMessageTokens(others.slice(i)) <= keepBudget) { splitIdx = i; break; }
        }
        if (splitIdx <= 0) return null;
        const oldBlock = others.slice(0, splitIdx);
        const keep = others.slice(splitIdx);
        if (oldBlock.length < MIN_COMPACT_BLOCK) return null;
        return { system, others, keep, oldBlock, estimated, budgetCap };
    }

    function applyCompaction(plan, summary) {
        const summaryText = `[Session memory — the earlier part of this conversation was compacted to keep the model reliable. Treat it as background context; it is NOT a new request. Rules and conventions in this block apply ONLY to the exact file/function/feature they are attached to in the summary — do NOT extend them to unrelated code, and do NOT invent requirements that are not explicitly written here. The active task is in the newest messages below.]\n\n${summary}`;
        const keep = plan.keep.map(m => ({ ...m }));
        let head = [{ role: 'user', content: summaryText }];
        if (keep.length > 0 && keep[0].role === 'user') {
            const first = { ...keep[0] };
            first.content = `${summaryText}\n\n---\n\n${messageText(first)}`;
            keep[0] = first;
            head = [];
        }
        return ensureUserMessage(repairTruncatedSequence(plan.system, [...head, ...keep]), plan.others);
    }

    const check = (name, cond, detail) => {
        if (cond) { safe++; console.log(`  PASS ${name}`); }
        else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
    };

    // Long agent session past the reliability limit (use a small limit so the
    // test stays fast; the logic is limit-agnostic).
    const m = [];
    m.push({ role: 'system', content: 'You are Nikas. '.repeat(40) });
    for (let r = 0; r < 40; r++) {
        m.push({ role: 'user', content: `Q${r}: implement feature ${r} ` + 'x'.repeat(400) });
        m.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${r}`, type: 'function', function: { name: 'edit', arguments: '{}' } }] });
        m.push({ role: 'tool', tool_call_id: `c${r}`, content: 'result ' + 'y'.repeat(2000) });
        m.push({ role: 'assistant', content: 'Done ' + 'z'.repeat(300) });
    }
    m.push({ role: 'user', content: 'Final task ' + 'q'.repeat(200) });
    const RELIABILITY_LIMIT = 40000;
    const est = estimateMessageTokens(m);
    check('long conversation over reliability limit', est > RELIABILITY_LIMIT, `est=${est.toLocaleString()} limit=${RELIABILITY_LIMIT}`);

    const plan = planCompaction(m, RELIABILITY_LIMIT);
    check('compaction plan produced', plan !== null, plan ? '' : 'plan is null');
    if (plan) {
        check('old block non-trivial (>= MIN_COMPACT_BLOCK)', plan.oldBlock.length >= MIN_COMPACT_BLOCK, `oldBlock=${plan.oldBlock.length}`);
        check('keep starts at a user turn (boundary snapped)', plan.keep.length === 0 || plan.keep[0].role === 'user', `keep[0]=${plan.keep[0]?.role}`);
        check('system preserved', plan.system.length === 1 && plan.system[0].role === 'system');
        check('oldBlock + keep == others (nothing lost in the split)', plan.oldBlock.length + plan.keep.length === plan.others.length, `${plan.oldBlock.length}+${plan.keep.length} vs ${plan.others.length}`);

        const out = applyCompaction(plan, 'MEMORY: features 0..30 done; convention: use edit tool; error E1 seen.');
        const issues = findDeepSeekIssues(out);
        check('compacted sequence valid', issues.length === 0, JSON.stringify(issues));
        check('session memory present', out.some(x => messageText(x).includes('MEMORY: features')), JSON.stringify(out.map(x => x.role)));
        check('summary wrapper has scoping guard', out.some(x => messageText(x).includes('apply ONLY to the exact file/function/feature') && messageText(x).includes('do NOT invent requirements')), 'scoping guard missing from summary wrapper');
        check('newest user turn survived verbatim', out.some(x => x.role === 'user' && messageText(x).includes('Final task')), JSON.stringify(out.map(x => x.role)));
        check('compacted result under limit (+slack)', estimateMessageTokens(out) <= RELIABILITY_LIMIT + 5000, `est=${estimateMessageTokens(out).toLocaleString()}`);
    }

    // Small window where available input < reliability limit: auto-compact must
    // STILL fire (capped at the window edge) instead of bailing to truncation —
    // this is the 256K-window-with-256K-limit case that used to slip through.
    const smallWindow = planCompaction(m, RELIABILITY_LIMIT, 20000);
    check('small window: compaction still fires at window edge', smallWindow !== null, smallWindow ? `budgetCap=${smallWindow.budgetCap}` : 'plan is null');
    if (smallWindow) {
        check('small window: capped at available input (not the limit)', smallWindow.budgetCap === 20000, `budgetCap=${smallWindow.budgetCap}`);
        check('small window: compacted result fits the window', estimateMessageTokens(applyCompaction(smallWindow, 'MEM: compacted')) <= 20000 + 5000, `est=${estimateMessageTokens(applyCompaction(smallWindow, 'MEM: compacted')).toLocaleString()}`);
    }
    // Window even smaller than the summary headroom → nothing worth compacting.
    check('tiny window: no compaction (no room for summary)', planCompaction(m, RELIABILITY_LIMIT, 1024) === null);

    // Under the limit → no compaction.
    const small = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi ' + 'x'.repeat(500) },
        { role: 'assistant', content: 'yo' },
    ];
    check('under limit → no compaction', planCompaction(small, RELIABILITY_LIMIT) === null);

    // Limit 0 → disabled (budget goes negative → no plan).
    check('limit 0 → disabled', planCompaction(m, 0) === null);

    // Old block too small to matter → no compaction.
    const tiny = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'a ' + 'x'.repeat(6000) },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c ' + 'x'.repeat(6000) },
        { role: 'assistant', content: 'd' },
    ];
    const tPlan = planCompaction(tiny, 4000);
    check('tiny old block → no compaction', tPlan === null || tPlan.oldBlock.length < MIN_COMPACT_BLOCK, tPlan ? `oldBlock=${tPlan.oldBlock.length}` : '');

    // Cache reuse rule (compact.ts): same anchor (oldest message identity) +
    // small growth → reuse the cached summary instead of another model call.
    const canReuse = (sameAnchor, cachedLen, blockLen) =>
        sameAnchor && blockLen >= cachedLen && blockLen - cachedLen < REUSE_GROWTH_THRESHOLD;
    check('reuse rule: same anchor + small growth reuses', canReuse(true, 100, 105));
    check('reuse rule: big growth recomputes', !canReuse(true, 100, 140));
    check('reuse rule: different anchor recomputes', !canReuse(false, 100, 105));

    // ── 14b. REGRESSION: many-small-messages over budget MUST compact ──
    // Reproduces the root cause: a long agent session with hundreds of small
    // tool/assistant messages. The OLD per-message keep loop summed each tiny
    // message and could "fit everything" (splitIdx=0) even when the AGGREGATE
    // estimate is well over the reliability limit — so compaction silently
    // never fired (observed at ~393K on a 512K window). The new aggregate-based
    // split must always produce a non-empty old block when over budget.
    {
        const msgs = [{ role: 'system', content: 'sys' }];
        for (let r = 0; r < 300; r++) {
            msgs.push({ role: 'user', content: `Q${r} ` + 'x'.repeat(100) });
            msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${r}`, type: 'function', function: { name: 'f', arguments: '{}' } }] });
            msgs.push({ role: 'tool', tool_call_id: `c${r}`, content: 'r ' + 'y'.repeat(200) });
        }
        msgs.push({ role: 'user', content: 'final' });
        const lim = 20000;
        const est = estimateMessageTokens(msgs);
        check('14b: aggregate over budget', est > lim, `est=${est} limit=${lim}`);
        const plan = planCompaction(msgs, lim);
        check('14b: compaction plan produced (NOT splitIdx=0)', plan !== null, plan ? '' : 'plan is null');
        if (plan) {
            check('14b: non-trivial old block', plan.oldBlock.length >= MIN_COMPACT_BLOCK, `oldBlock=${plan.oldBlock.length}`);
            check('14b: keep fits under budget', estimateMessageTokens(plan.keep) <= lim, `keep=${estimateMessageTokens(plan.keep)}`);
            const out = applyCompaction(plan, 'MEM: compacted');
            check('14b: compacted sequence valid', findDeepSeekIssues(out).length === 0, JSON.stringify(findDeepSeekIssues(out)));
            check('14b: newest user turn survives', out.some(x => x.role === 'user' && messageText(x).includes('final')));
        }
    }

    // ── 15. Summarizer prompt scoping (compact.ts SUMMARIZE_SYSTEM_PROMPT) ──
    // Mirrors the "Scoping (CRITICAL)" section added after the benchmark found
    // the executor over-applies vague universal rules from a contract (e.g.
    // inventing input.now on an endpoint that doesn't take it). Guards against
    // regressing the prompt to a generic "compress it" instruction.
    const SUMMARIZE_SYSTEM_PROMPT_MIRROR =
        'You are a session-memory summarizer for a long-running coding conversation.\n' +
        'Your job: compress the EARLIER part of a conversation into a compact memory block\n' +
        'that preserves everything the assistant might still need, so the conversation can\n' +
        'continue past the model\'s reliable context limit without losing facts.\n' +
        '\n' +
        'Preserve, verbatim where possible:\n' +
        '- concrete identifiers: file paths, function/class/variable names, tool names\n' +
        '- error messages and stack-trace fragments\n' +
        '- project conventions and decisions the user stated\n' +
        '- numbers, URLs, model/version names\n' +
        '- the current task, any unfinished work, and open questions\n' +
        '\n' +
        'Scoping (CRITICAL — the executor model over-applies vague rules):\n' +
        '- Keep EVERY rule/convention attached to the component it applies to\n' +
        '  (file, function, or feature). Never generalize a specific decision into\n' +
        '  a universal rule.\n' +
        '- Preserve negations and exceptions verbatim (e.g. "endpoint X takes ONLY\n' +
        '  { id } — no timestamp field", "do NOT use input.now here"). A rule that\n' +
        '  applied to one place must NOT be written as if it applies everywhere.\n' +
        '- Keep exact signatures and API names (e.g. db.selectAll(table, where,\n' +
        '  opts)); do not paraphrase them into a generic "use the db object".\n' +
        '- If a convention applied to one component only, say so explicitly.\n' +
        '\n' +
        'Rules:\n' +
        '- Do not add commentary, opinions, or new information.\n' +
        '- Keep short code snippets only if they encode a decision or convention.\n' +
        '- Be compact: prefer terse bullet lines over prose.\n' +
        '- Output ONLY the memory block. No preamble, no closing note.';
    check('summarizer prompt has scoping section', SUMMARIZE_SYSTEM_PROMPT_MIRROR.includes('Scoping (CRITICAL') && SUMMARIZE_SYSTEM_PROMPT_MIRROR.includes('Never generalize a specific decision'));
    check('summarizer prompt keeps negations verbatim', SUMMARIZE_SYSTEM_PROMPT_MIRROR.includes('do NOT use input.now here'));
    check('summarizer prompt keeps exact API names', SUMMARIZE_SYSTEM_PROMPT_MIRROR.includes('db.selectAll(table, where,'));
    check('summarizer prompt still compact-only output', SUMMARIZE_SYSTEM_PROMPT_MIRROR.includes('Output ONLY the memory block'));
}

console.log(`\n===== ${scenarios} targeted + 200 fuzz + coalescing + 9..14 → ${safe} safe, ${failures} failing =====`);
process.exit(failures ? 1 : 0);
