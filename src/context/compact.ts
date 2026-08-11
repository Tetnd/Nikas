import { streamDeepSeekChat } from '../api/deepseek.js';
import type { DeepSeekMessage } from '../api/types.js';

/**
 * Context compaction for long sessions.
 *
 * DeepSeek's coding reliability degrades once the ACTIVE context exceeds a
 * few hundred K REAL tokens (attention degradation / "lost in the middle" —
 * users consistently report ~220-300K for coding, and the Nikas harness
 * field baseline measured precision loss from ~300K on the 1M window). Letting
 * a 512K/950K window fill therefore hurts quality even though the API accepts
 * the request.
 *
 * Instead of filling the window (or blind-truncating the oldest content when
 * it does), this module compacts the OLDEST messages into a small "session
 * memory" summary whenever the conversation crosses the reliability limit.
 * The model keeps the newest turns verbatim (the active task) plus a
 * compressed record of everything earlier — so a session can span far more
 * than the reliability limit of WORK while the ACTIVE window stays under it,
 * and early facts survive in summarized form (no hallucination from dropped
 * facts).
 *
 * The compaction is deterministic per request: the provider is stateless
 * (VS Code re-sends the original history every turn), so the same input
 * always produces the same compacted sequence. The summary itself is a real
 * model call, but it is cached and only recomputed lazily as the old block
 * grows, so it happens ~once per REUSE_GROWTH_THRESHOLD messages — not on
 * every request.
 */

/** Model used for compaction summaries (fast + cheap; never the executor). */
export const SUMMARIZE_MODEL = 'deepseek-v4-flash';
/** Cap on the summary output size (real tokens). */
export const SUMMARY_MAX_TOKENS = 4_096;
/** Minimum number of old messages worth compacting (below: just truncate). */
export const MIN_COMPACT_BLOCK = 8;
/** Re-summarize only after the old block grew by at least this many messages. */
export const REUSE_GROWTH_THRESHOLD = 16;
/** Max cache entries (bounds memory; entries are small strings). */
const CACHE_MAX = 32;

const SUMMARIZE_SYSTEM_PROMPT =
    'You are a session-memory summarizer for a long-running coding conversation.\n' +
    'Your job: compress the EARLIER part of a conversation into a compact memory block\n' +
    'that preserves everything the assistant might still need, so the conversation can\n' +
    'continue past the model\'s reliable context limit without losing facts.\n' +
    '\n' +
    'Preserve, verbatim where possible:\n' +
    '- concrete identifiers: file paths, function/class/variable names, tool names\n' +
    '- error messages and stack-trace fragments\n' +
    '- project conventions and decisions the user stated\n' +
    '- numbers, URLs, model/version names\n' +
    '- the current task, any unfinished work, and open questions\n' +
    '\n' +
    'Scoping (CRITICAL — the executor model over-applies vague rules):\n' +
    '- Keep EVERY rule/convention attached to the component it applies to\n' +
    '  (file, function, or feature). Never generalize a specific decision into\n' +
    '  a universal rule.\n' +
    '- Preserve negations and exceptions verbatim (e.g. "endpoint X takes ONLY\n' +
    '  { id } — no timestamp field", "do NOT use input.now here"). A rule that\n' +
    '  applied to one place must NOT be written as if it applies everywhere.\n' +
    '- Keep exact signatures and API names (e.g. db.selectAll(table, where,\n' +
    '  opts)); do not paraphrase them into a generic "use the db object".\n' +
    '- If a convention applied to one component only, say so explicitly.\n' +
    '\n' +
    'Rules:\n' +
    '- Do not add commentary, opinions, or new information.\n' +
    '- Keep short code snippets only if they encode a decision or convention.\n' +
    '- Be compact: prefer terse bullet lines over prose.\n' +
    '- Output ONLY the memory block. No preamble, no closing note.';

/**
 * Instruction appended when the block already contains a PRIOR session-memory
 * block. That block is an already-lossy compression the model is relying on —
 * re-compressing it from scratch risks compounding fact loss (the "forgetting
 * within a session" failure mode: each recompute can drop facts the previous
 * one preserved). Instead, treat the prior memory as an AUTHORITATIVE baseline:
 * keep its facts, only add what's new from the surrounding turns.
 */
const PRESERVE_MEMORY_INSTRUCTION =
    '\n\nIMPORTANT — the conversation already contains a PRIOR session-memory block ' +
    '(a [Session memory] section). That block is authoritative existing memory the ' +
    'model is currently relying on.\n' +
    '- PRESERVE every fact, decision, identifier, and convention already in that ' +
    'prior block — copy them forward essentially verbatim.\n' +
    '- Do NOT re-compress, abbreviate, or drop anything already recorded there. ' +
    'Re-compressing prior memory is the #1 cause of losing facts across repeated ' +
    'compactions.\n' +
    '- ADD only the genuinely new facts from the messages AFTER the prior block ' +
    'that are not already captured.\n' +
    '- Keep the same structured sections; extend them rather than rewriting.';

interface CacheEntry {
    summary: string;
    /** Number of messages in the block this summary was computed from. */
    blockLen: number;
    /** Hash of the block's FIRST message — stable as the conversation grows. */
    anchor: string;
}

/**
 * Bounded summary cache. The provider is a process-wide singleton and VS Code
 * passes no session id to it, so "session scope" is derived from CONTENT: the
 * cache key hashes the block's full serialized text (see `blockHash`), and the
 * anchor-reuse fingerprint hashes each message's real text. That keeps every
 * conversation's summary under its own key — a second chat cannot collide with
 * or read the first chat's cached summary.
 */
const summaryCache = new Map<string, CacheEntry>();

/** Cheap deterministic string hash (FNV-1a-ish) — cache keys only. */
function simpleHash(input: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < input.length; i++) {
        const c = input.charCodeAt(i);
        h1 = (h1 ^ c) * 0x01000193;
        h2 = (h2 ^ c) * 0x85ebca6b;
    }
    return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).slice(0, 16);
}

/**
 * Stable identity of a message, for cache keys. Includes a hash of the
 * message's actual TEXT content — not just its role/shape/length.
 *
 * Without the content hash, two different conversations that happen to share
 * the same structural profile (same roles, same message lengths, same block
 * count) would produce IDENTICAL fingerprints. The compaction cache is a
 * process-wide singleton (VS Code re-sends the full history every turn and
 * passes no session/conversation id to the provider), so those two sessions
 * would collide on the same cache key and one conversation's summary could
 * be served to the other — cross-session fact-mixing. Hashing the real text
 * makes the fingerprint effectively unique per actual message, keeping each
 * conversation's summary scoped to the conversation it was built for.
 */
function messageFingerprint(msg: DeepSeekMessage): string {
    const contentShape = Array.isArray(msg.content)
        ? `arr:${msg.content.length}`
        : typeof msg.content === 'string'
            ? `str:${msg.content.length}`
            : 'null';
    const contentHash = simpleHash(messageText(msg));
    return `${msg.role}|${contentShape}|${contentHash}|${msg.tool_call_id ?? ''}|${msg.tool_calls?.length ?? 0}`;
}

/**
 * Bounded cache key — hash of the block's FULL serialized content.
 *
 * Two unrelated conversations whose edge messages happen to be identical
 * (e.g. both start and end with the same kind of message) still differ in the
 * middle, so hashing the whole block (not just first+last+length) guarantees
 * each session is cached under its own key. This is the primary guard against
 * cross-session summary bleed; `messageFingerprint`'s content hash covers the
 * anchor-reuse path below.
 */
function blockHash(block: DeepSeekMessage[]): string {
    return simpleHash(serializeBlock(block));
}

/** Plain-text content of a message ('' when none) — local copy, no provider dep. */
function messageText(msg: DeepSeekMessage): string {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && !!p.text)
            .map(p => p.text)
            .join(' ');
    }
    return '';
}

/**
 * Get (or create) the compacted summary for an old message block.
 *
 * Uses a bounded cache keyed by the block's edge hash. When the block has
 * grown only slightly since the last full summary (same anchor = same oldest
 * message, growth < REUSE_GROWTH_THRESHOLD), the previous summary is reused
 * instead of paying another model call — the marginal messages will be
 * captured at the next full recompute.
 */
export async function getOrCreateSummary(
    apiKey: string,
    block: DeepSeekMessage[],
    signal?: AbortSignal
): Promise<string> {
    const hash = blockHash(block);

    const cached = summaryCache.get(hash);
    if (cached) return cached.summary;

    const anchor = block.length > 0 ? messageFingerprint(block[0]) : '';
    if (anchor) {
        for (const entry of summaryCache.values()) {
            if (
                entry.anchor === anchor &&
                block.length >= entry.blockLen &&
                block.length - entry.blockLen < REUSE_GROWTH_THRESHOLD
            ) {
                // Same conversation, small growth — reuse the previous summary.
                return entry.summary;
            }
        }
    }

    const summary = await summarizeBlock(apiKey, block, signal);
    summaryCache.set(hash, { summary, blockLen: block.length, anchor });
    if (summaryCache.size > CACHE_MAX) {
        const oldest = summaryCache.keys().next().value;
        if (oldest !== undefined) summaryCache.delete(oldest);
    }
    return summary;
}

/** Serialize a message block into a compact, lossy-but-faithful text blob. */
function serializeBlock(block: DeepSeekMessage[]): string {
    const lines: string[] = [];
    for (const msg of block) {
        if (msg.role === 'tool') {
            lines.push(`[tool:${msg.tool_call_id ?? '?'}] ${messageText(msg)}`);
        } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
            lines.push(`[assistant tool_calls: ${msg.tool_calls.map(t => `${t.function.name}(${t.function.arguments})`).join(', ')}]`);
            const t = messageText(msg);
            if (t) lines.push(`[assistant] ${t}`);
        } else if (msg.reasoning_content) {
            lines.push(`[assistant reasoning] ${msg.reasoning_content}`);
            const t = messageText(msg);
            if (t) lines.push(`[assistant] ${t}`);
        } else {
            const t = messageText(msg);
            lines.push(`[${msg.role}] ${t}`);
        }
    }
    return lines.join('\n');
}

/**
 * Detect whether a block already contains a prior [Session memory] block.
 */
function hasPriorMemory(block: DeepSeekMessage[]): boolean {
    return block.some(msg => messageText(msg).includes('[Session memory'));
}

/**
 * Call DeepSeek (chat-completions, thinking off) to summarize an old block.
 * If the block already contains a prior session-memory block, adds the
 * preserve-instruction so the summary EXTENDS it rather than re-compressing
 * it from scratch (prevents compounding fact loss across recompactions).
 */
async function summarizeBlock(
    apiKey: string,
    block: DeepSeekMessage[],
    signal?: AbortSignal
): Promise<string> {
    const input = serializeBlock(block);
    const systemPrompt = hasPriorMemory(block)
        ? SUMMARIZE_SYSTEM_PROMPT + PRESERVE_MEMORY_INSTRUCTION
        : SUMMARIZE_SYSTEM_PROMPT;
    const request = {
        model: SUMMARIZE_MODEL,
        messages: [
            { role: 'system' as const, content: systemPrompt },
            { role: 'user' as const, content: input },
        ],
        temperature: 0,
        max_tokens: SUMMARY_MAX_TOKENS,
        stream: true,
        thinking: { type: 'disabled' as const },
    };

    let text = '';
    const result = await streamDeepSeekChat(
        request,
        apiKey,
        signal ?? new AbortController().signal,
        (t: string) => { text += t; },
        () => { /* summarizer must not call tools */ },
        () => { /* usage not needed here */ }
    );
    if (!result.receivedContent || !text.trim()) {
        throw new Error(`compaction summarizer returned no text (finish_reason: ${result.finishReason ?? 'none'})`);
    }
    return text.trim();
}

/** Clear the cache (used by tests). */
export function clearSummaryCache(): void {
    summaryCache.clear();
}
