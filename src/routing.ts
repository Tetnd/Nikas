import * as vscode from 'vscode';
import { getAgentEffort, AgentKind, ThinkingEffort } from './config.js';

/**
 * Request-kind classifier (lean re-add, v0.7.31, extended v0.7.67 for
 * per-agent effort).
 *
 * Copilot fires many different request shapes against the selected model:
 * - INTERNAL (invisible) helper requests: chat titles, git commit messages,
 *   branch names, rename suggestions, the settings resolver, the prompt
 *   categorizer, background todo tracking, etc. These produce no user-visible
 *   value, so deep reasoning on them is pure latency + cost.
 * - Agent sub-requests: the Plan agent, the Explore/ASK subagent, and inline
 *   chat. Each is detectable by its system prompt / tool signature and can
 *   carry its own thinking effort via `nikas.agentEfforts`.
 *
 * History:
 * - v0.7.27 removed the full Vizards routing (gated behind a setting, default
 *   OFF, for Nika-parity) along with the tool machinery.
 * - v0.7.31 re-added a LEAN version, default-on, gated behind
 *   `nikas.helperThinkingOff` (v0.7.32).
 * - v0.7.66 flipped `nikas.helperThinkingOff` default to false (Nika parity).
 * - v0.7.67 added `nikas.agentEfforts` for per-agent thinking effort.
 * - v0.7.69 removed `nikas.helperThinkingOff` entirely (Nika parity: no
 *   helper forcing; only per-agent agentEfforts remain).
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
    | 'plan-agent'
    | 'explore-agent'
    | 'inline-agent'
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
const PLAN_AGENT_PREFIX = 'You are a PLANNING AGENT';
const EXPLORE_AGENT_PREFIX = 'You are an ASK AGENT';

/** Internal helper kinds that produce no user-visible value. */
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
 * Map a RequestKind to its AgentKind for per-agent effort lookup.
 * - Internal helpers → 'helper'
 * - Plan agent → 'plan'
 * - Explore/ASK subagent → 'explore'
 * - inline → 'inline'
 * - main / unknown → 'main'
 */
export function requestKindToAgentKind(kind: RequestKind): AgentKind {
    if (INTERNAL_HELPER_KINDS.has(kind)) return 'helper';
    if (kind === 'plan-agent') return 'plan';
    if (kind === 'explore-agent') return 'explore';
    if (kind === 'inline-agent') return 'inline';
    return 'main';
}

/**
 * Resolve the final thinking effort for a request kind.
 *
 * Priority:
 *  1. If the per-agent effort map (`nikas.agentEfforts`) has an override
 *     for this request's agent kind → that effort.
 *  2. Else → the caller's normal effort resolution (configured effort).
 */
export function resolveAgentEffort(
    requestKind: RequestKind,
    baseEffort: ThinkingEffort,
): { effort: ThinkingEffort; source: 'agent-effort' | 'default' } {
    const override = getAgentEffort(requestKindToAgentKind(requestKind));
    if (override) {
        return { effort: override, source: 'agent-effort' };
    }
    return { effort: baseEffort, source: 'default' };
}

/**
 * Classify a provider request by inspecting the first text part of the input
 * messages and the available tool names.
 *
 * `initiator` (v0.7.88, A-1) is the authoritative `requestInitiator` from the
 * response options — which extension fired the request. When it maps to a
 * known agent/extension, it refines classification (an agent-initiated
 * request is never a pure helper) and is returned on the result so callers can
 * log/attribute it.
 */
export interface ClassifiedRequest {
    kind: RequestKind;
    initiator?: string;
    /** True when the initiator hint, rather than the message heuristic, decided the kind. */
    initiatorDriven?: boolean;
}

/** Known initiators → request-kind hints (v0.7.88, A-1). */
const INITIATOR_KIND_HINTS: Record<string, RequestKind> = {
    'github.copilot.editsAgent': 'main-agent',
    'github.copilot.chat.editsAgent': 'main-agent',
    'github.copilot.codeReview': 'main-agent',
    'github.copilot.chat': 'main-agent',
    'github.copilot.inlineChat': 'inline-agent',
};

export function classifyProviderRequest(input: {
    messages: readonly vscode.LanguageModelChatRequestMessage[];
    tools?: readonly vscode.LanguageModelChatTool[];
    initiator?: string;
}): ClassifiedRequest {
    const toolNames = (input.tools ?? []).map(t => t.name);
    const firstText = findFirstText(input.messages);
    const initiator = input.initiator?.trim();

    // A known agent initiator drives the kind authoritatively (it's more
    // reliable than prompt prefixes). Only used as a fallback signal when the
    // message heuristic would otherwise say "unknown" or a pure helper — the
    // user-facing system prompts still win for internal helpers.
    if (initiator && INITIATOR_KIND_HINTS[initiator]) {
        const hinted = INITIATOR_KIND_HINTS[initiator];
        if (firstText && (firstText.startsWith(MAIN_AGENT_PREFIX) || firstText.includes('<skills>'))) {
            // Main-style prompt + an agent initiator → agent work (not inline).
            const kind: RequestKind = hinted === 'inline-agent' && !isLikelyInline(toolNames) ? 'main-agent' : hinted;
            return { kind, initiator, initiatorDriven: true };
        }
        return { kind: hinted, initiator, initiatorDriven: true };
    }

    if (isOnlyTool(toolNames, 'categorize_prompt') || firstText.startsWith(PROMPT_CATEGORIZER_PREFIX)) {
        return { kind: 'prompt-categorizer', initiator };
    }
    if (firstText.startsWith(TODO_TRACKER_PREFIX)) {
        return { kind: 'todo-tracker', initiator };
    }
    if (firstText.startsWith(SETTINGS_RESOLVER_PREFIX)) {
        return { kind: 'settings-resolver', initiator };
    }
    if (startsWithAny(firstText, CHAT_TITLE_PREFIXES)) {
        return { kind: 'chat-title', initiator };
    }
    if (firstText.startsWith(INLINE_PROGRESS_MESSAGE_PREFIX)) {
        return { kind: 'inline-progress-message', initiator };
    }
    if (firstText.startsWith(GIT_BRANCH_NAME_PREFIX)) {
        return { kind: 'git-branch-name', initiator };
    }
    if (firstText.startsWith(GIT_COMMIT_MESSAGE_PREFIX)) {
        return { kind: 'git-commit-message', initiator };
    }
    if (firstText.startsWith(RENAME_SUGGESTIONS_PREFIX)) {
        return { kind: 'rename-suggestions', initiator };
    }
    if (firstText.startsWith(PLAN_AGENT_PREFIX)) {
        return { kind: 'plan-agent', initiator };
    }
    if (firstText.startsWith(EXPLORE_AGENT_PREFIX)) {
        return { kind: 'explore-agent', initiator };
    }
    // Inline chat shares the main agent's system prompt but runs with a
    // RESTRICTED tool set — inline requests don't carry the full agent
    // browser/terminal/search toolset. Heuristic: a "main-style" prompt with a
    // small/empty tool list is treated as inline.
    if (firstText.startsWith(MAIN_AGENT_PREFIX) || firstText.includes('<skills>')) {
        if (isLikelyInline(toolNames)) {
            return { kind: 'inline-agent', initiator };
        }
        return { kind: 'main-agent', initiator };
    }
    return { kind: 'unknown', initiator };
}

/**
 * Heuristic: inline chat requests run with a much smaller tool set than the
 * full agent mode. If we see the main-style prompt but only a small or empty
 * set of (non-browser, non-terminal, non-search) tools, treat it as inline.
 */
function isLikelyInline(toolNames: readonly string[]): boolean {
    if (toolNames.length === 0) return true;
    // Full agent mode always exposes these; their absence strongly implies inline.
    const agentHallmarks = ['open_browser_page', 'run_in_terminal', 'runInTerminal', 'browser', 'search', 'grep_search'];
    const hasHallmark = agentHallmarks.some(t => toolNames.includes(t));
    // Inline is still allowed a few edit/read tools, so only call it inline
    // when the set is genuinely small AND lacks agent hallmarks.
    return !hasHallmark && toolNames.length <= 4;
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
