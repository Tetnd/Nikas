/**
 * DeepSeek model router (v0.7.84) — optionally route request kinds to a
 * cheaper model. Gated by `nikas.modelRouter` (default OFF).
 *
 * PURE + vscode-free (unit-testable from plain Node, see test-model-route.js).
 * Only a type import from routing.ts (erased at compile time), so the compiled
 * module has no vscode dependency.
 *
 * Safety rules (from the roadmap):
 *  - NEVER route a Responses-family model id to /chat/completions. Routing
 *    only ever picks ANOTHER chat-completions model id.
 *  - Only route WITHIN the same API family, and only when there's a cheaper
 *    option that still handles the request.
 *
 * Current policy (conservative): internal helper requests (chat titles, git
 * commit messages, todo tracking, prompt categorization, etc.) produce NO
 * user-visible value, so when the user has selected the Pro chat model, they
 * are routed to the cheaper Flash chat model. Agent/user-visible requests
 * (main / plan / explore / inline / unknown) are left on the selected model.
 */

import type { RequestKind } from './routing.js';

/** Request kinds that produce no user-visible value and can use the cheap model. */
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

/** Known chat-completions family model ids. */
export const DEEPSEEK_CHAT_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;
/** The cheaper chat-completions model used for internal helpers. */
export const ROUTE_CHEAP_CHAT_MODEL = 'deepseek-v4-flash';

export interface RouteDecision {
    /** Alternative model id to use, if routing applies. */
    modelId?: string;
    /** Short human-readable reason. */
    reason?: string;
}

/**
 * Decide whether to route a request to a different DeepSeek chat model.
 *
 * @param requestKind   the classified request kind
 * @param currentModelId the currently selected model id
 * @param enabled       whether the model router is enabled (nikas.modelRouter)
 */
export function decideDeepSeekRoute(
    requestKind: RequestKind,
    currentModelId: string,
    enabled: boolean
): RouteDecision {
    if (!enabled) return {};
    // Only consider the chat-completions family — never the Responses model.
    if (!DEEPSEEK_CHAT_MODELS.includes(currentModelId as (typeof DEEPSEEK_CHAT_MODELS)[number])) {
        return {};
    }
    // Route only internal helpers to the cheap model, and only if we're not
    // already on the cheap model.
    if (INTERNAL_HELPER_KINDS.has(requestKind) && currentModelId !== ROUTE_CHEAP_CHAT_MODEL) {
        return { modelId: ROUTE_CHEAP_CHAT_MODEL, reason: `internal-helper:${requestKind}` };
    }
    return {};
}

/** Test helper: is this request kind an internal (cheap-eligible) helper? */
export function isInternalHelperKind(requestKind: RequestKind): boolean {
    return INTERNAL_HELPER_KINDS.has(requestKind);
}
