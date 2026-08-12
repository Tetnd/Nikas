/**
 * Nikas context-budget manager — live warnings + drop low-value tool output.
 *
 * PURE + vscode-free (unit-testable from plain Node, see test-budget.js).
 *
 * Two complementary behaviors, both purely additive and optional:
 *
 * 1. LIVE BUDGET WARNINGS — report how full the context window is so the user
 *    can act before truncation silently drops early facts. A status bar /
 *    output-channel warning fires when fill crosses the "warn" threshold, and
 *    a stronger one at "critical". Never blocks or alters the request.
 *
 * 2. DROP LOW-VALUE TOOL OUTPUT — when a conversation is over budget, instead
 *    of immediately discarding the oldest USER turns (losing real intent), we
 *    first reclaim tokens by removing LOW-VALUE tool-result messages — e.g.
 *    empty results, "No matches found" searches, near-empty outputs — together
 *    with their assistant tool_calls caller. These carry little signal but can
 *    consume large context. User turns are preserved until low-value reclaim
 *    is exhausted. The provider runs its normal repair afterward, so the
 *    sequence always stays valid.
 *
 * Heuristics stay conservative: only clearly-low-value tool results are
 * removed, and only from the OLDER portion (never the newest active turn).
 */

export type BudgetLevel = 'normal' | 'warn' | 'critical';

/** Minimal structural view of a conversation message the budget logic needs. */
export interface BudgetMessage {
    content?: unknown;
    role?: string;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
}

export interface BudgetStatus {
    level: BudgetLevel;
    fillPercent: number;
    estimated: number;
    available: number;
}

/** Cross this fill% → warn the user they're approaching the limit. */
export const WARN_THRESHOLD = 70;
/** Cross this fill% → strong warning; truncation is imminent. */
export const CRITICAL_THRESHOLD = 88;

/**
 * Classify how full the context window is. Pure — no side effects.
 */
export function getBudgetStatus(estimated: number, available: number): BudgetStatus {
    const fillPercent = available > 0
        ? Math.round((Math.max(0, estimated) / available) * 100)
        : 100;
    const level: BudgetLevel =
        fillPercent >= CRITICAL_THRESHOLD ? 'critical'
        : fillPercent >= WARN_THRESHOLD ? 'warn'
        : 'normal';
    return { level, fillPercent, estimated: Math.max(0, estimated), available };
}

/**
 * Low-value tool-result heuristic. A tool result is "low value" (safe to drop
 * to reclaim context) when its content is empty, trivially short, or a clear
 * "no results" signal that carries no facts worth keeping.
 */
export function isLowValueToolResult(text: string): boolean {
    const t = String(text ?? '').trim();
    if (t.length === 0) return true;
    if (t.length <= 8) return true; // e.g. "[]", "{}", "none", "0"
    const lower = t.toLowerCase();
    // "No matches found" / "no results" / "nothing" style signals (also the
    // P9-shortened forms). Conservative: only clear absence-of-result.
    if (/no matches found/.test(lower)) return true;
    if (/no results?/.test(lower)) return true;
    if (/^no (files?|items?|matches?|results?|output|content)/.test(lower)) return true;
    if (lower === 'n/a' || lower === 'na' || lower === 'null' || lower === 'undefined') return true;
    return false;
}

/**
 * Extract plain text from a message-like object (works on the DeepSeekMessage
 * shape; tolerant of missing fields). Local copy — no provider dependency.
 */
export function messageTextOf(msg: BudgetMessage | undefined): string {
    const c = msg?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        return c
            .filter((p): p is { type: string; text?: string } => !!p && p.type === 'text' && !!p.text)
            .map(p => (p.text as string) ?? '')
            .join(' ');
    }
    return '';
}

export interface LowValueDropOptions {
    /** Max tokens to reclaim. Default: drop as many low-value as found. */
    targetTokens?: number;
    /** Keep the newest N messages untouched (protect the active turn). */
    protectNewest?: number;
    /** Token estimator callback; defaults to chars/4 (cheap, for ranking only). */
    estimate?: (msg: BudgetMessage) => number;
}

export interface LowValueDropResult {
    messages: BudgetMessage[];
    /** Number of tool-result messages removed. */
    dropped: number;
    /** Estimated tokens freed (sum of removed messages). */
    freedTokens: number;
    /** Short previews of what was removed, for logging. */
    droppedPreviews: string[];
    /** True if we stopped early because the target was reached. */
    stoppedAtTarget: boolean;
}

const DEFAULT_ESTIMATE = (m: BudgetMessage): number =>
    Math.ceil(messageTextOf(m).length / 4);

/**
 * Remove low-value tool-result messages (and their assistant tool_calls caller)
 * from the OLDER portion of the conversation to reclaim context, preserving
 * user turns. Returns the filtered message list. Callers run their own sequence
 * repair afterward, so any residual orphaned tool results are cleaned up.
 *
 * Conservative + additive: never removes user or assistant text turns, never
 * touches the newest `protectNewest` messages, never throws.
 */
export function dropLowValueToolOutput(
    messages: BudgetMessage[] | undefined,
    opts: LowValueDropOptions = {}
): LowValueDropResult {
    const {
        targetTokens = Infinity,
        protectNewest = 4,
        estimate = DEFAULT_ESTIMATE,
    } = opts;

    const source = Array.isArray(messages) ? messages : [];
    const result: LowValueDropResult = {
        messages: [...source],
        dropped: 0,
        freedTokens: 0,
        droppedPreviews: [],
        stoppedAtTarget: false,
    };

    try {
        // Work from the oldest up, skipping the newest protectNewest messages.
        const removableRange = Math.max(0, result.messages.length - protectNewest);
        const remove = new Set<number>(); // indexes to remove

        for (let i = 0; i < removableRange; i++) {
            if (result.freedTokens >= targetTokens) { result.stoppedAtTarget = true; break; }
            const msg = result.messages[i];
            if (!msg || msg.role !== 'tool') continue;

            const text = messageTextOf(msg);
            if (!isLowValueToolResult(text)) continue;

            // Find this tool result's assistant tool_calls caller (nearest prior
            // assistant with a matching tool_call id) and remove it too, so we
            // don't leave an orphaned result or dangling tool_calls.
            const callId = msg.tool_call_id;
            let callerIdx = -1;
            for (let j = i - 1; j >= 0; j--) {
                const m = result.messages[j];
                if (m && m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === callId)) {
                    callerIdx = j;
                    break;
                }
                // Stop scanning once we leave the immediate tool-call group.
                if (m && (m.role === 'user' || m.role === 'system')) break;
            }

            // Remove the caller and this tool result.
            if (callerIdx >= 0) {
                remove.add(callerIdx);
                result.freedTokens += estimate(result.messages[callerIdx]);
            }
            remove.add(i);
            result.freedTokens += estimate(msg);
            result.dropped += 1;
            const preview = text.replace(/\s+/g, ' ').trim().slice(0, 60);
            result.droppedPreviews.push(`tool[${callId ?? '?'}] ${preview || '<empty>'}`);
        }

        if (remove.size > 0) {
            result.messages = result.messages.filter((_, idx) => !remove.has(idx));
        }
    } catch {
        // Never throw — on any error return the input unchanged.
        result.messages = [...source];
        result.dropped = 0;
        result.freedTokens = 0;
        result.droppedPreviews = [];
    }

    return result;
}
