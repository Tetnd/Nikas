// Tests the FIXED truncation logic (matches src/provider.ts after the fix).
// Ensures the resulting sequence is always valid for DeepSeek.
// NOTE: estimator is calibrated ×1.4 (mirrors ESTIMATE_CALIBRATION in provider.ts).
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

// ── FIXED logic (copy of src/provider.ts after repair) ──
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
        // Everything fits — still repair (conversation may end mid-tool-call).
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

// ── Validation: DeepSeek constraints ──
function findDeepSeekIssues(messages) {
    const issues = [];
    if (messages.length === 0) { issues.push('EMPTY request'); return issues; }
    const first = messages[0];
    if (first.role !== 'system' && first.role !== 'user') {
        issues.push(`First message role is "${first.role}" — must be system/user`);
    }
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const prev = i > 0 ? messages[i - 1] : null;
        const next = i < messages.length - 1 ? messages[i + 1] : null;
        if (msg.role === 'tool') {
            if (!prev || prev.role !== 'assistant' || !prev.tool_calls) {
                issues.push(`[${i}] tool result without preceding assistant tool_calls (${msg.tool_call_id})`);
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
process.exit(failures ? 1 : 0);
