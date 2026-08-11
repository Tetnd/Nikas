// test-compact-silent.js — verifies the "Compact Conversation" silent fix
// mirrors src/provider.ts (isCopilotCompactRequest + handleCopilotCompactRequest
// filter) and src/extension.ts (runSilentCompact auto-submit), v0.7.64.
//
// Problem: Copilot Chat's "Compact Conversation" button ran
// `github.copilot.chat.compact`, which ONLY opened the chat with `/compact`
// typed (preserveInput) — the user had to press Enter / type it manually, and
// then Copilot shipped the ENTIRE conversation to the model with a verbose
// "summarize everything" system prompt.
//
// Fix: (1) the button is overridden to auto-submit `/compact` (no manual
// typing); (2) the provider detects the resulting compaction request by its
// distinctive markers and handles it SILENTLY with the session-memory
// summarizer (same as auto-compact), instead of a full-conversation model call.
//
// This file mirrors the pure detection/filter logic so it stays runnable with
// plain node.

// ── Mirrors of src/provider.ts ──
const COPILOT_COMPACT_SYSTEM_MARKER =
    'create a comprehensive, detailed summary of the entire conversation';
const COPILOT_COMPACT_USER_MARKER = 'Summarize the conversation history so far';

// Mirror of the real Copilot C5n system prompt + user message.
const REAL_SYSTEM_PROMPT =
    'Your task is to create a comprehensive, detailed summary of the entire conversation ' +
    'that captures all essential information needed to seamlessly continue the work without ' +
    'any loss of context. This summary will be used to compact the conversation while ' +
    'preserving critical technical details, decisions, and progress.';
const REAL_USER_PROMPT =
    'Summarize the conversation history so far, paying special attention to the most recent ' +
    'agent commands and tool results that triggered this summarization.';

// Mirror of isCopilotCompactRequest(messages).
function isCopilotCompactRequest(messages) {
    for (const msg of messages) {
        for (const part of msg.content) {
            const text = part && part.value ? String(part.value) : '';
            if (text.includes(COPILOT_COMPACT_SYSTEM_MARKER)) return true;
            if (text.includes(COPILOT_COMPACT_USER_MARKER)) return true;
        }
    }
    return false;
}

// Mirror of handleCopilotCompactRequest's conversation filter: drop the C5n
// system message and the trailing "Summarize..." user message.
function filterConversation(messages) {
    return messages.filter((msg) => {
        const text = msg.content.map((p) => (p && p.value ? String(p.value) : '')).join(' ');
        return (
            !text.includes(COPILOT_COMPACT_SYSTEM_MARKER) &&
            !text.includes(COPILOT_COMPACT_USER_MARKER)
        );
    });
}

// ── Mirrors of src/extension.ts runSilentCompact (command sequence) ──
// chat.open {query, preserveInput:true} already auto-submits /compact (VS Code
// calls acceptInput(query)), so the button does NOT need a separate submit.
// A redundant workbench.action.chat.submit would double-fire (it has a
// "no request in progress" precondition) and break the button.
function runSilentCompact(cmds, failures = new Set()) {
    // Step 1: open chat with /compact (this auto-submits).
    const openOk = !failures.has('workbench.action.chat.open');
    if (!openOk) {
        // Fall back: retry open once (stock behavior).
        cmds.push('open-fallback');
        return { submitted: false };
    }
    cmds.push('open');
    // No separate submit step — chat.open with query+preserveInput already
    // submitted /compact. A second submit would double-fire.
    return { submitted: true };
}

// ── Tiny harness ──
let checks = 0, fails = 0;
function ok(cond, name) { checks++; if (!cond) { fails++; console.log(`  ✗ ${name}`); } }
function eq(a, b, name) { checks++; if (a !== b) { fails++; console.log(`  ✗ ${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); } }

function text(value) { return { value }; }

// ── 1. isCopilotCompactRequest detection ──
function sectionDetect() {
    // Real C5n compaction request shape: [system prompt, history..., user prompt].
    const real = [
        { role: 'system', content: [text(REAL_SYSTEM_PROMPT)] },
        { role: 'user', content: [text('user: fix bug')] },
        { role: 'assistant', content: [text('assistant: ok')] },
        { role: 'user', content: [text(REAL_USER_PROMPT)] },
    ];
    ok(isCopilotCompactRequest(real), 'real C5n compaction request detected');

    // System marker only.
    ok(isCopilotCompactRequest([
        { role: 'system', content: [text(REAL_SYSTEM_PROMPT)] },
        { role: 'user', content: [text('hi')] },
    ]), 'system marker detected');

    // User marker only.
    ok(isCopilotCompactRequest([
        { role: 'user', content: [text(REAL_USER_PROMPT)] },
    ]), 'user marker detected');

    // Normal agent request — NOT a compaction.
    ok(!isCopilotCompactRequest([
        { role: 'system', content: [text('You are an expert AI programming assistant')] },
        { role: 'user', content: [text('help me write code')] },
    ]), 'normal request not detected');

    // Partial/false markers must not match.
    ok(!isCopilotCompactRequest([
        { role: 'user', content: [text('please summarize the conversation so far')] },
    ]), 'near-miss user text not detected');
    ok(!isCopilotCompactRequest([
        { role: 'system', content: [text('You help create summaries')] },
    ]), 'near-miss system text not detected');

    // Empty / no-content messages.
    ok(!isCopilotCompactRequest([]), 'empty message list not detected');
    ok(!isCopilotCompactRequest([
        { role: 'user', content: [] },
    ]), 'empty content not detected');
}

// ── 2. Conversation filter drops only the marker messages ──
function sectionFilter() {
    const real = [
        { role: 'system', content: [text(REAL_SYSTEM_PROMPT)] },
        { role: 'user', content: [text('user: fix bug')] },
        { role: 'assistant', content: [text('assistant: ok')] },
        { role: 'user', content: [text('user: and tests')] },
        { role: 'assistant', content: [text('assistant: done')] },
        { role: 'user', content: [text(REAL_USER_PROMPT)] },
    ];
    const conv = filterConversation(real);
    eq(conv.length, 4, 'filter drops the 2 marker messages, keeps 4 history messages');
    ok(conv.some(m => m.content[0].value === 'user: fix bug'), 'keeps first user turn');
    ok(conv.some(m => m.content[0].value === 'assistant: done'), 'keeps last assistant turn');
    ok(!conv.some(m => m.content[0].value.includes('create a comprehensive, detailed summary')), 'C5n system dropped');
    ok(!conv.some(m => m.content[0].value.includes('Summarize the conversation history')), 'Summarize user dropped');

    // A normal request (no markers) is passed through unchanged.
    const normal = [
        { role: 'system', content: [text('You are an expert AI programming assistant')] },
        { role: 'user', content: [text('help')] },
    ];
    eq(filterConversation(normal).length, 2, 'normal request unchanged');
}

// ── 3. runSilentCompact auto-submits (no manual typing, no double-submit) ──
function sectionButton() {
    // Happy path: chat.open with query+preserveInput auto-submits /compact.
    // The button does NOT issue a separate chat.submit (would double-fire).
    {
        const cmds = [];
        const r = runSilentCompact(cmds);
        eq(cmds.join(','), 'open', 'button opens chat with /compact (auto-submits, no separate submit)');
        ok(r.submitted, 'button submits via chat.open auto-submit');
    }
    // Open failure → falls back to open (stock behavior, still useful).
    {
        const cmds = [];
        const r = runSilentCompact(cmds, new Set(['workbench.action.chat.open']));
        ok(!r.submitted, 'open failure not reported as submitted');
        ok(cmds.includes('open-fallback'), 'falls back to open on open failure');
    }
    // Guard: the button must never issue a second submit after chat.open.
    {
        const cmds = [];
        runSilentCompact(cmds);
        ok(!cmds.includes('submit'), 'no redundant workbench.action.chat.submit (double-submit guard)');
    }
}

sectionDetect();
sectionFilter();
sectionButton();
console.log(`${checks} checks, ${fails} fail`);
if (fails > 0) process.exit(1);
