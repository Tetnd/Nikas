// test-routing.js — verifies the request-kind classifier mirrors src/routing.ts.
//
// Covers:
//   1. classifyProviderRequest — internal helper kinds (chat titles, commit
//      messages, branch names, settings resolver, todo tracker, prompt
//      categorizer, rename suggestions, inline progress)
//   2. shouldForceThinkingNone — internal helpers force thinking OFF; real
//      agent/main-agent/unknown requests keep the configured effort.
//
// Mirrors the ported upstream classifier (Vizards #137).

// ── Mirrors of src/routing.ts ──

const TODO_TRACKER_PREFIX = 'You are a background task tracker';
const PROMPT_CATEGORIZER_PREFIX = 'You are an expert classifier for AI coding assistant prompts';
const SETTINGS_RESOLVER_PREFIX =
    'You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings';
const CHAT_TITLE_PREFIXES = [
    'You are an expert in crafting ultra-compact titles',
    'You are an expert in crafting pithy titles',
];
const INLINE_PROGRESS_MESSAGE_PREFIX =
    'You are an expert in writing short, catchy, and encouraging progress messages';
const GIT_BRANCH_NAME_PREFIX = 'You are an expert in crafting pithy branch names';
const GIT_COMMIT_MESSAGE_PREFIX =
    'You are an AI programming assistant, helping a software developer to come with the best git commit message';
const RENAME_SUGGESTIONS_PREFIX = 'You are a distinguished software engineer';
const MAIN_AGENT_PREFIX = 'You are an expert AI programming assistant';
const TERMINAL_NOTIFICATION_PATTERN = /^\[Terminal\s+\S+\s+notification:/;

const REQUEST_KINDS_WITH_FORCED_NONE_THINKING = new Set([
    'todo-tracker',
    'prompt-categorizer',
    'settings-resolver',
    'chat-title',
    'inline-progress-message',
    'git-branch-name',
    'git-commit-message',
    'rename-suggestions',
]);

function shouldForceThinkingNone(requestKind) {
    return REQUEST_KINDS_WITH_FORCED_NONE_THINKING.has(requestKind);
}

// Messages are plain { content: [{ type: 'text', value }] } — mirrors the
// text-part extraction in routing.ts.
function classifyProviderRequest({ messages, tools }) {
    const toolNames = (tools ?? []).map(t => t.name);
    const firstText = findFirstText(messages ?? []);

    if (isOnlyTool(toolNames, 'categorize_prompt') || firstText.startsWith(PROMPT_CATEGORIZER_PREFIX)) {
        return 'prompt-categorizer';
    }
    if (firstText.startsWith(TODO_TRACKER_PREFIX)) {
        return 'todo-tracker';
    }
    if (firstText.startsWith(SETTINGS_RESOLVER_PREFIX)) {
        return 'settings-resolver';
    }
    if (startsWithAny(firstText, CHAT_TITLE_PREFIXES)) {
        return 'chat-title';
    }
    if (firstText.startsWith(INLINE_PROGRESS_MESSAGE_PREFIX)) {
        return 'inline-progress-message';
    }
    if (firstText.startsWith(GIT_BRANCH_NAME_PREFIX)) {
        return 'git-branch-name';
    }
    if (firstText.startsWith(GIT_COMMIT_MESSAGE_PREFIX)) {
        return 'git-commit-message';
    }
    if (firstText.startsWith(RENAME_SUGGESTIONS_PREFIX)) {
        return 'rename-suggestions';
    }
    if (firstText.startsWith(MAIN_AGENT_PREFIX) || firstText.includes('<skills>')) {
        return 'main-agent';
    }
    if (TERMINAL_NOTIFICATION_PATTERN.test(firstText)) {
        return 'terminal-steering';
    }
    return 'unknown';
}

function findFirstText(messages) {
    for (const message of messages) {
        for (const part of message.content ?? []) {
            if (part.type === 'text' && part.value && part.value.trim()) {
                return part.value.trim();
            }
        }
    }
    return '';
}

function isOnlyTool(toolNames, toolName) {
    return toolNames.length === 1 && toolNames[0] === toolName;
}

function startsWithAny(text, prefixes) {
    return prefixes.some(prefix => text.startsWith(prefix));
}

// ── Test harness ──
let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS ${name}`); }
    else { fail++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

const msg = (text) => ({ content: [{ type: 'text', value: text }] });
const tool = (name) => ({ name });

console.log('=== 1. Internal helper kinds ===');
check('chat title (ultra-compact) → chat-title', classifyProviderRequest({ messages: [msg('You are an expert in crafting ultra-compact titles\nRules:...')] }) === 'chat-title');
check('chat title (pithy) → chat-title', classifyProviderRequest({ messages: [msg('You are an expert in crafting pithy titles')] }) === 'chat-title');
check('git commit message → git-commit-message', classifyProviderRequest({ messages: [msg('You are an AI programming assistant, helping a software developer to come with the best git commit message')] }) === 'git-commit-message');
check('branch name → git-branch-name', classifyProviderRequest({ messages: [msg('You are an expert in crafting pithy branch names')] }) === 'git-branch-name');
check('settings resolver → settings-resolver', classifyProviderRequest({ messages: [msg('You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings')] }) === 'settings-resolver');
check('todo tracker → todo-tracker', classifyProviderRequest({ messages: [msg('You are a background task tracker')] }) === 'todo-tracker');
check('prompt categorizer (prefix) → prompt-categorizer', classifyProviderRequest({ messages: [msg('You are an expert classifier for AI coding assistant prompts')] }) === 'prompt-categorizer');
check('prompt categorizer (single tool) → prompt-categorizer', classifyProviderRequest({ messages: [msg('anything')], tools: [tool('categorize_prompt')] }) === 'prompt-categorizer');
check('rename suggestions → rename-suggestions', classifyProviderRequest({ messages: [msg('You are a distinguished software engineer\nSuggest renames for:')] }) === 'rename-suggestions');
check('inline progress → inline-progress-message', classifyProviderRequest({ messages: [msg('You are an expert in writing short, catchy, and encouraging progress messages')] }) === 'inline-progress-message');

console.log('\n=== 2. Real user/agent requests stay unforced ===');
check('main agent prefix → main-agent', classifyProviderRequest({ messages: [msg('You are an expert AI programming assistant, working with a user in the VS Code editor.')] }) === 'main-agent');
check('skills marker → main-agent', classifyProviderRequest({ messages: [msg('Work in this workspace.\n<skills>\nlist\n</skills>')] }) === 'main-agent');
check('terminal steering → terminal-steering', classifyProviderRequest({ messages: [msg('[Terminal 1] notification: build failed')] }) === 'terminal-steering');
check('plain user prompt → unknown', classifyProviderRequest({ messages: [msg('fix the bug in provider.ts')] }) === 'unknown');
check('empty messages → unknown', classifyProviderRequest({ messages: [] }) === 'unknown');
check('no text parts → unknown', classifyProviderRequest({ messages: [{ content: [] }] }) === 'unknown');

console.log('\n=== 3. shouldForceThinkingNone ===');
const forced = ['todo-tracker', 'prompt-categorizer', 'settings-resolver', 'chat-title', 'inline-progress-message', 'git-branch-name', 'git-commit-message', 'rename-suggestions'];
for (const kind of forced) {
    check(`forces off: ${kind}`, shouldForceThinkingNone(kind) === true);
}
check('does NOT force: main-agent', shouldForceThinkingNone('main-agent') === false);
check('does NOT force: terminal-steering', shouldForceThinkingNone('terminal-steering') === false);
check('does NOT force: unknown', shouldForceThinkingNone('unknown') === false);

console.log('');
console.log(`===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
