import * as vscode from 'vscode';

/**
 * Request-kind classifier.
 *
 * Copilot fires many INTERNAL (invisible) requests against the selected model:
 * chat titles, git commit messages, branch names, rename suggestions, the
 * settings resolver, the prompt categorizer, background todo tracking, etc.
 * These produce no user-visible value, so running them at `max` thinking
 * effort is pure latency + cost — especially with `nikas.thinkingEffort`
 * defaulting to `max`.
 *
 * Ported from upstream Vizards/deepseek-v4-for-copilot (provider/routing/
 * classifier.ts, v0.6.1 #137).
 */
export type RequestKind =
    | 'todo-tracker'
    | 'terminal-steering'
    | 'prompt-categorizer'
    | 'settings-resolver'
    | 'chat-title'
    | 'inline-progress-message'
    | 'git-branch-name'
    | 'git-commit-message'
    | 'rename-suggestions'
    | 'main-agent'
    | 'unknown';

const TODO_TRACKER_PREFIX = 'You are a background task tracker';
const PROMPT_CATEGORIZER_PREFIX = 'You are an expert classifier for AI coding assistant prompts';
const SETTINGS_RESOLVER_PREFIX =
    'You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings';
const CHAT_TITLE_PREFIXES = [
    'You are an expert in crafting ultra-compact titles',
    'You are an expert in crafting pithy titles',
] as const;
const INLINE_PROGRESS_MESSAGE_PREFIX =
    'You are an expert in writing short, catchy, and encouraging progress messages';
const GIT_BRANCH_NAME_PREFIX = 'You are an expert in crafting pithy branch names';
const GIT_COMMIT_MESSAGE_PREFIX =
    'You are an AI programming assistant, helping a software developer to come with the best git commit message';
const RENAME_SUGGESTIONS_PREFIX = 'You are a distinguished software engineer';
const MAIN_AGENT_PREFIX = 'You are an expert AI programming assistant';
const TERMINAL_NOTIFICATION_PATTERN = /^\[Terminal\s+\S+\s+notification:/;

/** Internal helper kinds that must never burn thinking tokens. */
const REQUEST_KINDS_WITH_FORCED_NONE_THINKING = new Set<RequestKind>([
    'todo-tracker',
    'prompt-categorizer',
    'settings-resolver',
    'chat-title',
    'inline-progress-message',
    'git-branch-name',
    'git-commit-message',
    'rename-suggestions',
]);

/** Whether this request kind must run with thinking forced OFF. */
export function shouldForceThinkingNone(requestKind: RequestKind): boolean {
    return REQUEST_KINDS_WITH_FORCED_NONE_THINKING.has(requestKind);
}

/**
 * Classify a provider request by inspecting the first text part of the input
 * messages and the available tool names.
 */
export function classifyProviderRequest(input: {
    messages: readonly vscode.LanguageModelChatRequestMessage[];
    tools?: readonly vscode.LanguageModelChatTool[];
}): RequestKind {
    const toolNames = (input.tools ?? []).map(t => t.name);
    const firstText = findFirstText(input.messages);

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

function findFirstText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    for (const message of messages) {
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart && part.value.trim()) {
                return part.value.trim();
            }
        }
    }
    return '';
}

function isOnlyTool(toolNames: readonly string[], toolName: string): boolean {
    return toolNames.length === 1 && toolNames[0] === toolName;
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
    return prefixes.some((prefix) => text.startsWith(prefix));
}
