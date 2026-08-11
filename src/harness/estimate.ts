/**
 * Lightweight token estimator + context guard for the agent loop.
 *
 * The provider (src/provider.ts) has a full content-aware estimator, but it
 * depends on vscode. The loop needs a pure, dependency-free estimate so it can
 * keep its own accumulated tool-result history within a bounded budget over
 * many iterations (a long agent run otherwise grows the message list without
 * bound and eventually blows the DeepSeek window).
 *
 * This is intentionally simpler than the provider estimator — it only needs to
 * be "good enough" to bound loop history, not to gate API requests.
 */

/** Rough chars-per-token. Conservative (lower = estimates more tokens). */
const CHARS_PER_TOKEN = 4;

/** Estimate tokens for a string (plain, deterministic). */
export function estimateTextTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate tokens for a DeepSeek-format message. */
export function estimateMessageTokens(msg: {
    content?: string | Array<{ type: string; text?: string }> | null;
    name?: string;
}): number {
    let total = 8; // per-message JSON framing overhead
    if (typeof msg.content === 'string') {
        total += estimateTextTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
            if (p.type === 'text' && p.text) total += estimateTextTokens(p.text);
        }
    }
    if (msg.name) total += estimateTextTokens(msg.name);
    return total;
}

/** Estimate tokens for a full message list. */
export function estimateMessagesTokens(messages: Array<{
    content?: string | Array<{ type: string; text?: string }> | null;
    name?: string;
}>): number {
    let total = 0;
    for (const m of messages) total += estimateMessageTokens(m);
    return total;
}

export interface GuardOptions {
    /** Soft budget (tokens) for accumulated tool-result history. Default 120_000. */
    maxHistoryTokens?: number;
    /** When over budget, drop the OLDEST tool messages, keeping at least this many newest. Default 6. */
    keepNewest?: number;
}

/**
 * Keep the tool-result history within a token budget by dropping the oldest
 * `role:'tool'` messages (and their preceding assistant tool-call messages)
 * when the accumulated estimate exceeds the budget. Returns a bounded copy.
 *
 * Assumes `messages` starts with [system, user, ...] and tool results come in
 * assistant(tool_calls) → tool pairs. Non-tool messages (system/user/final
 * assistant text) are always preserved.
 */
export function guardToolHistory(
    messages: Array<{
        role: string;
        content?: string | Array<{ type: string; text?: string }> | null;
        tool_call_id?: string;
    }>,
    options: GuardOptions = {},
): Array<{
    role: string;
    content?: string | Array<{ type: string; text?: string }> | null;
    tool_call_id?: string;
}> {
    const budget = options.maxHistoryTokens ?? 120_000;
    const keepNewest = options.keepNewest ?? 6;
    const est = estimateMessagesTokens(messages as never[]);
    if (est <= budget) return messages;

    // Drop oldest tool/assistant pairs until under budget or only the newest
    // `keepNewest` tool messages remain.
    let result = messages.slice();
    while (estimateMessagesTokens(result as never[]) > budget) {
        // Find index of first tool message.
        const firstTool = result.findIndex(m => m.role === 'tool');
        if (firstTool === -1) break;

        // Count how many tool messages exist; keep the newest ones.
        const toolCount = result.filter(m => m.role === 'tool').length;
        if (toolCount <= keepNewest) {
            // We've trimmed to the keep threshold but still over budget — stop
            // (avoid dropping everything). Return what we have.
            break;
        }

        // Remove this tool message and its immediately-preceding assistant
        // tool-call message (if any) to keep the sequence valid.
        const remove = new Set<number>([firstTool]);
        // Walk back to the nearest assistant with tool_calls or the previous tool boundary.
        for (let i = firstTool - 1; i >= 0; i--) {
            if (result[i].role === 'assistant') {
                remove.add(i);
                break;
            }
            if (result[i].role === 'tool') break; // already in a tool block
            // user message — leave it, stop walking back
            break;
        }
        result = result.filter((_, idx) => !remove.has(idx));
    }
    return result;
}
