#!/usr/bin/env node
// test-directive.js — verifies the agent directive (CONCISE_PROMPT_DIRECTIVE)
// is injected correctly in both the chat-completions and Responses paths, and
// that it contains the anti-spin language added to fix the agent "spin" bug.
//
// Mirrors the injection logic in src/provider.ts:
//   - chat path: appends the directive to the FIRST system message content
//   - responses path: appends the directive to `instructions`
//
// Run: node test-directive.js

// ── Mirror of src/config.ts CONCISE_PROMPT_DIRECTIVE (kept in sync) ──
const CONCISE_PROMPT_DIRECTIVE =
    'You are a coding agent. Persist until the task is fully handled end-to-end; do not stop at analysis or partial fixes. ' +
    'Unless the user explicitly asks for a plan or a question, ASSUME they want you to make changes and RUN TOOLS to do it — outputting a proposed solution instead of acting is bad. ' +
    'Every turn must either call a tool or give a final result; never just describe what you would do. ' +
    'Never restate the same plan more than once — if you have already planned a step, EXECUTE it now with a tool call. ' +
    'Prefer the edit tools (replace_string_in_file / multi_replace_string_in_file) over rewriting whole files. ' +
    'Batch independent read-only calls (searches, file reads) together. ' +
    'Do not give up unless you are sure the request cannot be fulfilled with the tools you have; gather context first, then act. ' +
    'Repeating a plan in text instead of acting is a failure. ' +
    'Give only the final, concise result.';

// ── Mirror of the chat-path injection (provider.ts) ──
function injectChatDirective(deepseekMessages, enabled) {
    if (!enabled || !deepseekMessages || deepseekMessages.length === 0) return deepseekMessages;
    const first = deepseekMessages[0];
    if (first.role === 'system') {
        const base = typeof first.content === 'string'
            ? first.content
            : Array.isArray(first.content)
                ? first.content.map(p => p.type === 'text' ? p.text : '').join('')
                : '';
        first.content = `${base}\n\n${CONCISE_PROMPT_DIRECTIVE}`;
        return deepseekMessages;
    }
    // No leading system message → prepend one carrying the directive (mirrors
    // the provider fix so the directive is always applied).
    deepseekMessages.unshift({ role: 'system', content: CONCISE_PROMPT_DIRECTIVE });
    return deepseekMessages;
}

// ── Mirror of the responses-path injection (provider.ts) ──
function injectResponsesDirective(instructions, enabled) {
    const directive = enabled ? `\n\n${CONCISE_PROMPT_DIRECTIVE}` : '';
    if (instructions) return instructions + directive;
    if (directive) return CONCISE_PROMPT_DIRECTIVE;
    return instructions;
}

// ── Test runner ──
let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name); }
}

console.log('=== 1. Chat path: directive appended to first system message ===');
{
    const msgs = [{ role: 'system', content: 'You are DeepSeek.' }, { role: 'user', content: 'hi' }];
    const out = injectChatDirective(msgs, true);
    check('appends directive to system content', typeof out[0].content === 'string' && out[0].content.startsWith('You are DeepSeek.') && out[0].content.includes('You are a coding agent'));
    check('preserves original system text', out[0].content.includes('You are DeepSeek.'));
    check('contains anti-spin line', out[0].content.includes('Never restate the same plan more than once'));
    check('contains act-not-describe line', out[0].content.includes('Every turn must either call a tool or give a final result'));
}

console.log('=== 2. Chat path: disabled → no injection ===');
{
    const msgs = [{ role: 'system', content: 'You are DeepSeek.' }, { role: 'user', content: 'hi' }];
    const out = injectChatDirective(msgs, false);
    check('no directive when disabled', out[0].content === 'You are DeepSeek.');
}

console.log('=== 3. Chat path: no system message → directive prepended as new system ===');
{
    const msgs = [{ role: 'user', content: 'hi' }];
    const out = injectChatDirective(msgs, true);
    check('prepends a system message with the directive', out.length === 2 && out[0].role === 'system' && out[0].content === CONCISE_PROMPT_DIRECTIVE);
    check('keeps the original user message after', out[1].content === 'hi');
}

console.log('=== 4. Chat path: array-content system message handled ===');
{
    const msgs = [{ role: 'system', content: [{ type: 'text', text: 'Base sys.' }] }, { role: 'user', content: 'hi' }];
    const out = injectChatDirective(msgs, true);
    check('extracts text from array content and appends', typeof out[0].content === 'string' && out[0].content.startsWith('Base sys.') && out[0].content.includes('You are a coding agent'));
}

console.log('=== 5. Responses path: directive appended to instructions ===');
{
    const out = injectResponsesDirective('You are DeepSeek.', true);
    check('appends directive to instructions', out.startsWith('You are DeepSeek.') && out.includes('You are a coding agent'));
}

console.log('=== 6. Responses path: no instructions → directive becomes instructions ===');
{
    const out = injectResponsesDirective(undefined, true);
    check('directive used as instructions when none present', out === CONCISE_PROMPT_DIRECTIVE);
}

console.log('=== 7. Responses path: disabled → unchanged ===');
{
    const out = injectResponsesDirective('You are DeepSeek.', false);
    check('no directive when disabled', out === 'You are DeepSeek.');
}

console.log('=== 8. Directive content sanity ===');
{
    check('mentions edit tools', CONCISE_PROMPT_DIRECTIVE.includes('replace_string_in_file'));
    check('mentions batching', CONCISE_PROMPT_DIRECTIVE.toLowerCase().includes('batch'));
    check('anti-spin: act not describe', CONCISE_PROMPT_DIRECTIVE.includes('Every turn must either call a tool or give a final result'));
    check('anti-spin: never restate plan', CONCISE_PROMPT_DIRECTIVE.includes('Never restate the same plan more than once'));
    check('anti-spin: repeating plan is failure', CONCISE_PROMPT_DIRECTIVE.includes('Repeating a plan in text instead of acting is a failure'));
    check('no strict narration ban (Nika parity)', !CONCISE_PROMPT_DIRECTIVE.includes('Do not narrate'));
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
