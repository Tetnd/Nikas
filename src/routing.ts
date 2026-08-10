import * as vscode from 'vscode';

/**
 * Request-kind classifier (lean re-add, v0.7.31).
 *
 * Copilot fires many INTERNAL (invisible) requests against the selected
 * model: chat titles, git commit messages, branch names, rename suggestions,
 * the settings resolver, the prompt categorizer, background todo tracking,
 * etc. These produce no user-visible value, so running them at `max` thinking
 * effort is pure latency + cost with nothing to show.
 *
 * History:
 * - v0.7.27 removed the full Vizards routing (gated behind a setting, default
 *   OFF, for Nika-parity) along with the tool machinery.
 * - v0.7.31 re-adds a LEAN version, DEFAULT-ON: the user's configured
 *   thinking effort still applies to the real (executor) agent — the model
 *   that picks tools and does the actual work — but invisible helper
 *   requests are always forced to thinking `off`. This is the "executor max,
 *   helpers none" setup the user wants.
 */
export type RequestKind =
    | 'todo-tracker'
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

/** Internal helper kinds that produce no user-visible value — never burn thinking tokens on these. */
const INTERNAL_HELPER_KINDS = new Set<RequestKind>([
    'todo-tracker',
    'prompt-categorizer',
    'settings-resolver',
    'chat-title',
    'inline-progress-message',
    'git-branch-name',
    'git-commit-message',
    'rename-suggestions',
]);

/**
 * Whether this request kind is an invisible internal helper that should run
 * with thinking FORCED OFF (always on in v0.7.31 — no setting gate). The
 * configured thinking effort still applies to everything else (the real
 * agent / executor).
 */
export function shouldForceHelperThinkingOff(requestKind: RequestKind): boolean {
    return INTERNAL_HELPER_KINDS.has(requestKind);
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
