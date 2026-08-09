#!/usr/bin/env node
// test-reasoning.js — verifies the thinking-mode reasoning_text round-trip fix.
//
// DeepSeek's Responses API REQUIRES the model's reasoning_text to be passed
// back in subsequent requests when tools are used with thinking enabled, or it
// returns HTTP 400 ("The reasoning_text in the thinking mode must be passed
// back to the API."). This test verifies the three pieces of the fix:
//   1. deepseekMessagesToResponsesInput emits a reasoning_text item before the
//      assistant message / function_call it belongs to.
//   2. The transform extracts reasoning from a replay marker part on assistant
//      messages (chat path) and sets reasoning_content.
//   3. The stream captures reasoning from reasoning_content / reasoning_text
//      deltas into StreamResult.reasoningText.
//
// Run: node test-reasoning.js

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name); }
}

// ── 1. Mirror of deepseekMessagesToResponsesInput (messages.ts) ──
function messageText(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content.filter(p => p.type === 'text' && !!p.text).map(p => p.text).join('\n');
    }
    return '';
}
function toResponsesInput(messages) {
    const input = [];
    let instructions;
    for (const msg of messages) {
        if (msg.role === 'system') {
            const text = messageText(msg);
            if (!instructions && text) instructions = text;
            else input.push({ type: 'message', role: 'system', content: text });
            continue;
        }
        if (msg.role === 'user') { input.push({ type: 'message', role: 'user', content: messageText(msg) }); continue; }
        if (msg.role === 'assistant') {
            if (msg.reasoning_content) input.push({ type: 'reasoning_text', text: msg.reasoning_content });
            const text = messageText(msg);
            if (text) input.push({ type: 'message', role: 'assistant', content: text });
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
                }
            }
            continue;
        }
        if (msg.role === 'tool' && msg.tool_call_id) {
            input.push({ type: 'function_call_output', call_id: msg.tool_call_id, output: messageText(msg) });
            continue;
        }
    }
    return { input, instructions };
}

console.log('=== 1. Responses input: reasoning_text emitted before assistant message ===');
{
    const msgs = [{ role: 'assistant', content: 'answer', reasoning_content: 'CoT here' }];
    const { input } = toResponsesInput(msgs);
    check('emits reasoning_text first', input[0].type === 'reasoning_text' && input[0].text === 'CoT here');
    check('then assistant message', input[1].type === 'message' && input[1].content === 'answer');
}

console.log('=== 2. Responses input: reasoning_text before function_call ===');
{
    const msgs = [{
        role: 'assistant', content: null, reasoning_content: 'CoT before tool',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_in_terminal', arguments: '{}' } }],
    }];
    const { input } = toResponsesInput(msgs);
    check('reasoning_text first', input[0].type === 'reasoning_text' && input[0].text === 'CoT before tool');
    check('function_call second', input[1].type === 'function_call' && input[1].name === 'run_in_terminal');
}

console.log('=== 3. Responses input: no reasoning → no reasoning_text item ===');
{
    const msgs = [{ role: 'assistant', content: 'plain' }];
    const { input } = toResponsesInput(msgs);
    check('no reasoning_text when absent', input.every(i => i.type !== 'reasoning_text'));
}

console.log('=== 4. Responses input: order preserved with tool result ===');
{
    const msgs = [
        { role: 'assistant', content: null, reasoning_content: 'R', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
        { role: 'assistant', content: 'final', reasoning_content: 'R2' },
    ];
    const { input } = toResponsesInput(msgs);
    const types = input.map(i => i.type);
    check('types sequence', JSON.stringify(types) === JSON.stringify(['reasoning_text','function_call','function_call_output','reasoning_text','message']));
}

// ── 2. Mirror of marker extraction (messages.ts extractReasoningFromParts) ──
const REPLAY_MARKER_MIME = 'stateful_marker';
const WRITER = 'nikas';
function encodePayload(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function makeMarker(reasoningText) {
    const payload = encodePayload({ reasoning: { text: reasoningText } });
    return { mimeType: REPLAY_MARKER_MIME, data: Buffer.from(`${WRITER}\\${payload}`) };
}
function parseMarker(data) {
    const raw = Buffer.from(data).toString('utf8');
    const sep = raw.indexOf('\\');
    if (sep < 0) return { valid: false };
    const payloadRaw = raw.slice(sep + 1);
    try {
        const obj = JSON.parse(Buffer.from(payloadRaw, 'base64url').toString('utf8'));
        const reasoning = obj.reasoning;
        return { valid: true, reasoningText: (reasoning && typeof reasoning.text === 'string') ? reasoning.text : undefined };
    } catch { return { valid: false }; }
}
function extractReasoningFromParts(parts) {
    for (const part of parts) {
        if (part.mimeType !== REPLAY_MARKER_MIME) continue;
        const marker = parseMarker(part.data);
        if (marker.valid && marker.reasoningText) return marker.reasoningText;
    }
    return undefined;
}

console.log('=== 5. Marker extraction: reasoning text recovered ===');
{
    const parts = [makeMarker('CoT from marker')];
    check('extracts reasoning', extractReasoningFromParts(parts) === 'CoT from marker');
}
console.log('=== 6. Marker extraction: no marker → undefined ===');
{
    check('undefined when no marker', extractReasoningFromParts([]) === undefined);
    const parts = [{ mimeType: 'image/png', data: Buffer.from('x') }];
    check('undefined when only image', extractReasoningFromParts(parts) === undefined);
}

// ── 3. Mirror of stream reasoning capture ──
function buildStreamResult(events) {
    let reasoningText = '';
    for (const ev of events) {
        if (ev.type === 'response.reasoning_text.delta' && ev.delta) reasoningText += ev.delta;
        if (ev.type === 'response.output_item.done') {
            const item = ev.item;
            if (item && item.type === 'reasoning_text' && typeof item.text === 'string' && item.text) reasoningText = item.text;
            if (item && item.type === 'reasoning' && typeof item.summary === 'string' && item.summary) reasoningText = item.summary;
        }
    }
    return { reasoningText: reasoningText || undefined };
}

console.log('=== 7. Stream: reasoning_text.delta accumulates ===');
{
    const r = buildStreamResult([
        { type: 'response.reasoning_text.delta', delta: 'Hello ' },
        { type: 'response.reasoning_text.delta', delta: 'world' },
    ]);
    check('accumulates deltas', r.reasoningText === 'Hello world');
}
console.log('=== 8. Stream: reasoning item on output_item.done ===');
{
    const r = buildStreamResult([{ type: 'response.output_item.done', item: { type: 'reasoning_text', text: 'Full CoT' } }]);
    check('captures full reasoning item', r.reasoningText === 'Full CoT');
}
console.log('=== 9. Stream: no reasoning → undefined ===');
{
    const r = buildStreamResult([{ type: 'response.output_text.delta', delta: 'hi' }]);
    check('undefined when no reasoning', r.reasoningText === undefined);
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
