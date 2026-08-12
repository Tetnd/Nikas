import * as vscode from 'vscode';
import { SecretStore } from './secrets.js';
import { DEEPSEEK_MODELS, DEEPSEEK_RESPONSES_MODEL, getConfig, getSelectedModel, getMaxTokens, getTemperature, ThinkingEffort, getThinkingEffort, getContextWindowTokens, getContextWindowPreset, getContextReliabilityLimit, getVisionModelKey, getVisionSource, VisionSource, getConcisePrompt, CONCISE_PROMPT_DIRECTIVE, getCopilotKnowledge, getContextBudget, getContextWarnThreshold, getContextCriticalThreshold, getModelRouter, getModelRouterMode, getModelRouterKinds, getToolBudget, getToolBudgetTokens, getModelThinkingDefault, getResponsesHeavyPro } from './config.js';
import { augmentToolDescription, getToolKnowledge } from './harness/copilotKnowledge.js';
import { vscodeMessagesToDeepSeek, deepseekMessagesToResponsesInput } from './transform/messages.js';
import { streamDeepSeekChat, streamDeepSeekResponses } from './api/deepseek.js';
import { safeStringify } from './api/sanitize.js';
import { resolveImageMessages, resolveSparsePdfVision, resolveVisionDescriber } from './vision/pipeline.js';
import { VSCodeLanguageModelVisionDescriber, findAutoVisionModel } from './vision/sources/vscode-lm.js';
import { createReplayMarkerPart, hasImageParts } from './vision/replay.js';
import { classifyProviderRequest, resolveAgentEffort, requestKindToAgentKind } from './routing.js';
import { decideDeepSeekRoute } from './modelRoute.js';
import { assertToolsWithinLimit } from './tools/request.js';
import { trimToolDescriptions, estimateToolTokens } from './tools/budget.js';
import { getOrCreateSummary, MIN_COMPACT_BLOCK, SUMMARY_MAX_TOKENS } from './context/compact.js';
import { dropLowValueToolOutput } from './context/budget.js';
import { usageTracker, setCurrentSessionKey } from './usage/tracker.js';
import { persistSessionMemory, injectPersistentMemory } from './memory/manager.js';
import { log } from './log.js';
import { visionLog } from './vision/log.js';
import type { DeepSeekRequest, DeepSeekTool, DeepSeekMessage, DeepSeekResponsesRequest, DeepSeekResponsesTool, DeepSeekContentPart } from './api/types.js';
import type { ReplayMarkerMetadata } from './vision/types.js';

/**
 * VS Code Output channel for Nikas diagnostics.
 * Visible in View → Output → "Nikas".
 */
let _outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
    if (!_outputChannel) {
        _outputChannel = vscode.window.createOutputChannel('Nikas');
    }
    return _outputChannel;
}

/**
 * Model-picker metadata (non-public API surface, same shape Copilot Chat
 * consumes). `isBYOK` marks the model as bring-your-own-key so Copilot
 * renders the provider appropriately (upstream Vizards #162). Only
 * genuinely bring-your-own-key models (Gemini, Gemma) carry the flag;
 * DeepSeek models deliberately do NOT so they stay plain Nikas models.
 */
type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
    isBYOK?: true;
    configurationSchema?: ReturnType<typeof buildThinkingEffortSchema>;
};

/**
 * Emit DeepSeek's thinking-mode chain-of-thought as a native VS Code
 * "thinking" part so it renders in the chat UI exactly like Copilot's own
 * models (collapsed thinking block). Uses the PROPOSED
 * `LanguageModelThinkingPart` API (`vscode.proposed.languageModelThinkingPart`):
 * available at runtime in recent VS Code builds but not in the stable
 * `@types/vscode`, so we feature-detect and cast. On older VS Code builds the
 * reasoning is still round-tripped via the replay marker (no 400) but not
 * displayed.
 */
function reportThinkingPart(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    text: string,
): void {
    if (!text) return;
    try {
        // Accessing the member can throw when the proposal is not enabled
        // (VS Code gates proposed API), so the whole access is try/caught.
        const vscodeAny = vscode as unknown as Record<string, unknown>;
        const ctor = vscodeAny.LanguageModelThinkingPart;
        if (typeof ctor !== 'function') return;
        const part = new (ctor as new (value: string) => unknown)(text);
        progress.report(part as vscode.LanguageModelResponsePart);
    } catch (err) {
        log.verbose(`Failed to emit thinking part: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * DeepSeek's hard per-request ceiling: 1,048,576 total tokens (input +
 * output). Kept in one place so every preset and the truncation budget can
 * stay safely below it even with estimator error or thinking-mode reasoning.
 */
const API_TOTAL_CEILING = 1_048_576;
/** Extra headroom reserved below the hard ceiling for estimator error. */
const API_CEILING_SAFETY = 65_536;

/**
 * Token density constants (chars per token) tuned for DeepSeek's BPE tokenizer.
 *
 * A single global ratio mis-estimates agent-heavy workloads by 2-3×, which
 * makes truncation fire at the wrong time and silently evicts early context —
 * exactly the "the model loses it past ~300K" symptom. We therefore estimate
 * per content shape:
 *   - natural-language prose:      ~4.0 chars/token
 *   - code / JSON / tool args:     ~2.5 chars/token (punctuation-heavy)
 *   - base64 / hex / minified:     ~1.4 chars/token (low-entropy runs)
 *
 * A residual adaptive factor (see adaptiveCalibration) closes the remaining
 * gap using the API's ground-truth usage on every request, so truncation
 * timing stays honest for whatever workload the user actually runs.
 */
const PROSE_CHARS_PER_TOKEN = 4.0;
const STRUCTURED_CHARS_PER_TOKEN = 2.5;
const BASE64_CHARS_PER_TOKEN = 1.4;
/** Segments with at least this punctuation fraction count as code/JSON. */
const STRUCTURED_PUNCT_THRESHOLD = 0.15;

/** Matches long base64 runs (data URIs, hex dumps, token blobs). */
const BASE64_RUN_RE = /[A-Za-z0-9+/=]{32,}/g;
/** Matches non-word, non-space chars (Unicode-aware — Hebrew/Cyrillic etc.). */
const PUNCT_RE = /[^\p{L}\p{N}\s_]/gu;

/**
 * Estimate tokens for a text string. Splits it into base64 runs (very dense),
 * then classifies the remaining segments as prose (~4 chars/token) or
 * code/JSON/tool output (~2.5 chars/token) by punctuation density.
 * Deterministic and side-effect free — the test harness mirrors this logic.
 */
function estimateTextTokens(text: string): number {
    if (!text) return 0;
    let total = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    BASE64_RUN_RE.lastIndex = 0;
    while ((m = BASE64_RUN_RE.exec(text)) !== null) {
        if (m.index > last) {
            total += estimateSegmentTokens(text.slice(last, m.index));
        }
        total += Math.ceil(m[0].length / BASE64_CHARS_PER_TOKEN);
        last = m.index + m[0].length;
    }
    if (last < text.length) {
        total += estimateSegmentTokens(text.slice(last));
    }
    return total;
}

/**
 * Estimate tokens for a non-base64 segment by classifying it as prose or
 * structured (code/JSON/tool output). Punctuation-heavy segments are dense.
 */
function estimateSegmentTokens(segment: string): number {
    if (!segment) return 0;
    const punctCount = (segment.match(PUNCT_RE) ?? []).length;
    const punctDensity = punctCount / segment.length;
    const charsPerToken = punctDensity >= STRUCTURED_PUNCT_THRESHOLD
        ? STRUCTURED_CHARS_PER_TOKEN
        : PROSE_CHARS_PER_TOKEN;
    return Math.ceil(segment.length / charsPerToken);
}

/**
 * Adaptive calibration: the per-shape ratios above are close but not exact,
 * and real density varies by workload. We learn the residual
 * (real API tokens / estimated tokens) from every request's ground-truth
 * usage and apply it as an exponentially-weighted factor. Seeded at 1.1 (a
 * small safety margin — NOT the old blanket ×1.4, which overcounted prose by
 * ~40% and caused premature truncation); converges within a few requests and
 * is clamped to a sane range.
 */
const ADAPTIVE_ALPHA = 0.25;
const ADAPTIVE_FLOOR = 0.8;
const ADAPTIVE_CEIL = 4.0;
/** Default calibration factor when no session context is available. */
const DEFAULT_CALIBRATION = 1.1;
/** Max per-session calibration factors kept in memory (bounds a small map). */
const CALIBRATION_CACHE_MAX = 32;

/**
 * Adaptive calibration is inherently workload- and session-dependent: code,
 * JSON and base64-heavy contexts are denser than prose, and the residual
 * (real/estimated tokens) is learned from real API usage. Because the provider
 * is a process-wide singleton shared by every open chat, a SINGLE scalar
 * learned from ALL sessions would let one conversation's workload skew
 * truncation/compaction timing for another — cross-session bleed (one chat's
 * density drives another chat to truncate/compact too early, evicting early
 * context). So we keep one factor PER session, keyed by the content-derived
 * session key (see getSessionKeyFromDeepSeek), and fall back to the default
 * when no session context is available (e.g. the standalone token-count meter,
 * which receives a single message and cannot know its conversation).
 */
const calibrationBySession = new Map<string, number>();

/** Calibration factor for a session (default when unknown or no key). */
function getCalibration(sessionKey?: string): number {
    if (sessionKey) {
        const v = calibrationBySession.get(sessionKey);
        if (v !== undefined) return v;
    }
    return DEFAULT_CALIBRATION;
}

/** Apply the learned calibration factor to a raw token estimate. */
function applyCalibration(raw: number, sessionKey?: string): number {
    return Math.ceil(raw * getCalibration(sessionKey));
}

/**
 * Observed real/estimated token ratio per session — the ground-truth density
 * of the conversation's content (code/JSON/base64-heavy sessions run ~1.2x
 * real vs prose at ~1.0x).
 *
 * The adaptive calibration EMA above is fed by its OWN estimates, so it
 * converges to sqrt(density) and leaves the estimate systematically LOW on
 * dense workloads (feedback loop). This map instead stores the RAW observed
 * ratio, letting maybeCompactContext correct its decision into real-token
 * space — the reliability limit is specified in REAL tokens (config.ts).
 *
 * The MAX ratio is kept per session: history only grows, so once a density
 * has been observed it stays representative — and after compaction the sent
 * sequence shrinks, which would otherwise dilute the ratio and flip
 * compaction back off (churn).
 */
const densityRatioBySession = new Map<string, number>();
/** Floor/ceiling for the learned density ratio (guards against garbage). */
const DENSITY_RATIO_MIN = 1.0;
const DENSITY_RATIO_MAX = 4.0;
/** Only learn density from requests with at least this many estimated tokens. */
const DENSITY_LEARN_MIN_ESTIMATED = 20_000;

/** Real/estimated token density correction for a session (1.0 when unknown). */
function getDensityRatio(sessionKey?: string): number {
    if (!sessionKey) return DENSITY_RATIO_MIN;
    return densityRatioBySession.get(sessionKey) ?? DENSITY_RATIO_MIN;
}

/**
 * Feed one ground-truth sample (API prompt_tokens vs our estimate of the
 * messages actually sent) into the per-session adaptive calibration. Rejects
 * garbage. Without a session key there is nothing to scope the observation to,
 * so it is dropped rather than corrupting a shared scalar.
 */
function observeCalibration(
    sessionKey: string | undefined,
    realTokens: number,
    estimatedTokens: number
): void {
    if (!sessionKey) return;
    if (!Number.isFinite(realTokens) || !Number.isFinite(estimatedTokens)) return;
    if (realTokens <= 0 || estimatedTokens <= 0) return;
    const ratio = realTokens / estimatedTokens;
    if (ratio <= 0 || ratio > 12) return;
    const next = Math.min(
        ADAPTIVE_CEIL,
        Math.max(ADAPTIVE_FLOOR, ADAPTIVE_ALPHA * ratio + (1 - ADAPTIVE_ALPHA) * getCalibration(sessionKey))
    );
    calibrationBySession.set(sessionKey, next);
    if (calibrationBySession.size > CALIBRATION_CACHE_MAX) {
        const oldest = calibrationBySession.keys().next().value;
        if (oldest !== undefined) calibrationBySession.delete(oldest);
    }

    // Track the RAW observed real/estimated ratio (max per session) for the
    // compaction decision — see densityRatioBySession. Only learned from
    // sizable requests; tiny exchanges (titles, subagent spins) are noise.
    if (estimatedTokens >= DENSITY_LEARN_MIN_ESTIMATED) {
        const clamped = Math.min(DENSITY_RATIO_MAX, Math.max(DENSITY_RATIO_MIN, ratio));
        const prev = densityRatioBySession.get(sessionKey) ?? 0;
        if (clamped > prev) {
            densityRatioBySession.set(sessionKey, clamped);
            if (densityRatioBySession.size > CALIBRATION_CACHE_MAX) {
                const oldest = densityRatioBySession.keys().next().value;
                if (oldest !== undefined) densityRatioBySession.delete(oldest);
            }
        }
    }
}

function estimateMessageTokens(messages: DeepSeekMessage[], sessionKey?: string): number {
    let total = 0;
    for (const msg of messages) {
        // Base overhead per message (role + name + JSON framing, ~8 tokens).
        total += 8;
        if (typeof msg.content === 'string') {
            total += estimateTextTokens(msg.content);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text) {
                    total += estimateTextTokens(part.text);
                } else if (part.type === 'image_url' && part.image_url?.url) {
                    // Data URIs carry a base64 payload — count it at base64
                    // density. Previously counted as ZERO, which hid the
                    // single biggest context consumer from truncation.
                    const url = part.image_url.url;
                    const comma = url.indexOf(',');
                    const payload = comma >= 0 ? url.slice(comma + 1) : url;
                    total += estimateTextTokens(payload);
                }
            }
        }
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                total += estimateTextTokens(tc.function.name);
                total += estimateTextTokens(tc.function.arguments);
            }
        }
        // Thinking-mode CoT round-tripped on assistant messages also consumes
        // context — count it so truncation fires before the API ceiling.
        if (msg.reasoning_content) {
            total += estimateTextTokens(msg.reasoning_content);
        }
    }
    return applyCalibration(total, sessionKey);
}

/**
 * Derive a stable per-conversation key from DeepSeek messages' CONTENT.
 *
 * VS Code passes no session/conversation id to the provider, so session state
 * must be reconstructed in-band. Hashing the text of the earliest user turns
 * distinguishes conversations (stable within a chat, distinct across chats)
 * while staying cheap. This mirrors the vision pipeline's
 * `sessionKeyFromMessages`, but operates on the DeepSeek format used here.
 * It MUST be called on the ORIGINAL history, before compaction replaces the
 * oldest user turns with a `[Session memory ...]` summary — otherwise the key
 * would change after the first compaction and split one conversation into two
 * calibration buckets.
 */
function getSessionKeyFromDeepSeek(messages: DeepSeekMessage[]): string {
    let h = 0x811c9dc5;
    let userTurns = 0;
    for (const msg of messages) {
        if (msg.role !== 'user') continue;
        const text = messageText(msg);
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            h ^= c;
            h = Math.imul(h, 0x01000193);
        }
        userTurns++;
        if (userTurns >= 3) break;
    }
    return (h >>> 0).toString(36);
}

/**
 * Short human-readable preview of a message, for truncation diagnostics.
 * Kept brief — truncation can drop many messages and we only log a few.
 */
function messagePreview(msg: DeepSeekMessage, maxLen = 80): string {
    let text = '';
    if (typeof msg.content === 'string') {
        text = msg.content;
    } else if (Array.isArray(msg.content)) {
        text = msg.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && !!p.text)
            .map(p => p.text)
            .join(' ')
            .slice(0, maxLen);
    }
    if (msg.role === 'tool') {
        return `tool[${msg.tool_call_id ?? '?'}] ${text.replace(/\s+/g, ' ').trim().slice(0, maxLen)}`;
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const names = msg.tool_calls.map(tc => tc.function.name).join(',');
        return `assistant(tool_calls: ${names})`;
    }
    const body = text.replace(/\s+/g, ' ').trim();
    return body ? `${msg.role}: ${body.slice(0, maxLen)}` : `${msg.role}: <empty>`;
}

/** Extract plain-text content from a DeepSeek message ('' when none). */
function messageText(msg: DeepSeekMessage): string {
    if (typeof msg.content === 'string') {
        return msg.content;
    }
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((p): p is DeepSeekContentPart & { type: 'text'; text: string } => p.type === 'text' && !!p.text)
            .map(p => p.text)
            .join(' ');
    }
    return '';
}

// ---------------------------------------------------------------------------
// Copilot "Compact Conversation" interception
// ---------------------------------------------------------------------------
//
// Copilot Chat's "Compact Conversation" button (and the `/compact` slash
// command) run `github.copilot.chat.compact`, which just opens the chat input
// with `/compact` typed — the user still has to send it, and then Copilot
// ships the ENTIRE conversation to the model with a verbose "summarize
// everything" system prompt (the C5n prompt below). That is slow, costs a
// full-context model call, and differs from Nikas's own silent auto-compact
// (which summarizes the OLDEST messages into a cached session-memory block).
//
// Fix (v0.7.64):
//   1. The "Compact Conversation" button is overridden (see extension.ts) so
//      it auto-submits `/compact` instead of requiring manual typing.
//   2. When the resulting compaction request reaches this provider, it is
//      detected here and handled SILENTLY with the SAME session-memory
//      summarizer that auto-compact uses (`getOrCreateSummary`): fast,
//      cached, thinking-off — matching "silently like auto compact" instead
//      of a verbose full-conversation DeepSeek call.
const COPILOT_COMPACT_SYSTEM_MARKER =
    'create a comprehensive, detailed summary of the entire conversation';
const COPILOT_COMPACT_USER_MARKER = 'Summarize the conversation history so far';

/** Plain-text value of a VS Code chat message part ('' when none). */
function vscodePartText(part: unknown): string {
    if (part instanceof vscode.LanguageModelTextPart) return part.value;
    return '';
}

/**
 * True when this request is Copilot's conversation-compaction request
 * (the `Compact Conversation` button / `/compact` slash command). Copilot
 * renders it with a distinctive system prompt ("Your task is to create a
 * comprehensive, detailed summary of the entire conversation...") plus a
 * trailing user message ("Summarize the conversation history so far...").
 */
export function isCopilotCompactRequest(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
): boolean {
    for (const msg of messages) {
        for (const part of msg.content) {
            const text = vscodePartText(part);
            if (text.includes(COPILOT_COMPACT_SYSTEM_MARKER)) return true;
            if (text.includes(COPILOT_COMPACT_USER_MARKER)) return true;
        }
    }
    return false;
}

/**
 * Log the context fill / truncation status of a request.
 *
 * Emits a WARN (and an output-channel line) when messages had to be dropped —
 * that is the moment the model starts losing memory of early facts, which is
 * exactly when hallucination risk begins.
 */
function logContextHealth(
    estimatedTokens: number,
    availableInputTokens: number,
    fillPercent: number,
    dropped: DeepSeekMessage[] = []
): void {
    const line =
        `Context health: ~${estimatedTokens.toLocaleString()} tokens of ` +
        `${availableInputTokens.toLocaleString()} available ` +
        `(${fillPercent}% fill, preset ${getContextWindowPreset()})`;

    if (dropped.length > 0) {
        const droppedTokens = estimateMessageTokens(dropped);
        const previews = dropped.slice(0, 6).map(messagePreview).map(p => `    ${p}`).join('\n');
        const msg =
            `${line}\n` +
            `  ⚠ TRUNCATION: dropped ${dropped.length} message(s), ` +
            `~${droppedTokens.toLocaleString()} tokens\n` +
            `  Oldest dropped content (model can no longer see this):\n${previews}\n` +
            `  → Early facts are now forgotten. If answers look confident-but-wrong, ` +
            `this is why. Consider a larger context window or a fresh session.`;
        log.warn(msg);
        getOutputChannel().appendLine(`[Nikas] ${msg.replace(/\n/g, '\n[Nikas] ')}`);
    } else {
        log.info(line);
    }
}

/**
 * Log actual API token usage against the configured context window AND feed
 * the adaptive calibration with a ground-truth sample (see observeCalibration).
 * The API's real prompt_tokens is the ground truth for how close we are to
 * the limit — the local estimate can drift on unusual content.
 */
function logUsageVsWindow(
    promptTokens: number,
    completionTokens: number,
    estimatedSentTokens: number,
    sessionKey?: string
): void {
    // Learn the real estimate→actual ratio for this workload so truncation
    // timing stays honest (see observeCalibration). Scoped to the session.
    observeCalibration(sessionKey, promptTokens, estimatedSentTokens);

    const windowTokens = getContextWindowTokens();
    const fillPct = Math.round((promptTokens / windowTokens) * 100);
    const base =
        `DeepSeek usage: prompt=${promptTokens.toLocaleString()} ` +
        `(${fillPct}% of ${windowTokens.toLocaleString()} window), ` +
        `completion=${completionTokens.toLocaleString()}`;
    const criticalPct = getContextCriticalThreshold();
    const warnPct = getContextWarnThreshold();
    if (fillPct >= criticalPct) {
        const msg =
            `${base}\n` +
            `  ⚠ Prompt is ${fillPct}% of the context window (critical). The next truncation ` +
            `will drop the oldest messages — the model loses memory of early facts and may ` +
            `hallucinate about them. Start a new session for fresh context.`;
        log.warn(msg);
        getOutputChannel().appendLine(`[Nikas] ${msg.replace(/\n/g, '\n[Nikas] ')}`);
    } else if (fillPct >= warnPct) {
        const msg =
            `${base}\n` +
            `  ⚠ Approaching the context window (${fillPct}% ≥ warn ${warnPct}%). Consider ` +
            `compacting or starting a new session before facts are truncated away.`;
        log.warn(msg);
        getOutputChannel().appendLine(`[Nikas] ${msg.replace(/\n/g, '\n[Nikas] ')}`);
    } else {
        log.info(base);
    }
}

/**
 * Truncate messages to fit within the configured context window.
 *
 * Preserves the system message (first message) and removes oldest user/assistant
 * messages when the context is exceeded.
 *
 * CRITICAL: the result must remain a VALID DeepSeek message sequence. A naive
 * newest-kept truncation can break tool-call/tool-result pairs:
 *   - an `assistant` message with `tool_calls` kept as the LAST message (its
 *     tool results were older/truncated) → DeepSeek HTTP 400
 *   - the first kept message being `assistant`/`tool` (leading `user` dropped)
 *     → DeepSeek HTTP 400 (conversation must start with system/user)
 * This is exactly what happened during Copilot Chat's auto-compact, which
 * fires when the conversation is at max size (agent loops end mid-tool-call).
 *
 * The repair runs on EVERY request (not just when truncating): a conversation
 * that already fits can still end mid-tool-call, and DeepSeek rejects that.
 */
function truncateMessagesToContextWindow(messages: DeepSeekMessage[], sessionKey?: string): DeepSeekMessage[] {
    const maxContextTokens = getContextWindowTokens();
    const maxOutputTokens = getMaxTokens();
    // Reserve space for output — input context = total - max_output - safety buffer.
    // Clamp to a small floor so the budget can never go negative (which would
    // drop every message and produce an empty request → HTTP 400). Also clamp
    // below the API's hard ceiling with extra safety for estimator error, so a
    // slightly-underestimated request can never push past 1,048,576 and 400.
    const availableInputTokens = Math.max(
        1024,
        Math.min(
            maxContextTokens - maxOutputTokens - 1024,
            API_TOTAL_CEILING - maxOutputTokens - API_CEILING_SAFETY
        )
    );

    const systemMessages: DeepSeekMessage[] = [];
    const otherMessages: DeepSeekMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'system' && systemMessages.length === 0) {
            systemMessages.push(msg);
        } else {
            otherMessages.push(msg);
        }
    }

    const estimatedTokens = estimateMessageTokens(messages, sessionKey);
    const fillPercent = Math.round((estimatedTokens / availableInputTokens) * 100);

    if (estimatedTokens <= availableInputTokens) {
        // Everything fits — but the sequence may still be invalid (e.g. the
        // conversation ends mid-tool-call during auto-compact). Repair it,
        // then guarantee a user message survives — a fits-but-user-less loop
        // would otherwise be sent system-only → DeepSeek HTTP 400.
        const repaired = repairTruncatedSequence(systemMessages, otherMessages);
        const finalSeq = ensureUserMessage(repaired, otherMessages);
        logContextHealth(estimatedTokens, availableInputTokens, fillPercent);
        return finalSeq;
    }

    // ── Context-budget reclaim (v0.7.81) ───────────────────────────────
    // Before discarding the oldest USER turns (losing real intent), try to
    // reclaim tokens by dropping LOW-VALUE tool output (empty / "No matches
    // found" / trivial results) plus their assistant tool_calls callers. This
    // preserves user context when possible. Purely additive + conservative,
    // gated by nikas.contextBudget; on any failure we fall through to normal
    // truncation unchanged.
    if (getContextBudget()) {
        const targetTokens = estimatedTokens - availableInputTokens + 512; // a little headroom
        const reclaim = dropLowValueToolOutput(otherMessages, {
            targetTokens,
            protectNewest: 6,
            estimate: (m) => estimateMessageTokens([m as DeepSeekMessage], sessionKey),
        });
        if (reclaim.dropped > 0) {
            const afterReclaim = estimateMessageTokens(
                [...systemMessages, ...(reclaim.messages as DeepSeekMessage[])],
                sessionKey
            );
            if (afterReclaim < estimatedTokens) {
                const reclaimedTokens = estimatedTokens - afterReclaim;
                log.info(
                    `Context budget: reclaimed ~${reclaimedTokens.toLocaleString()} tokens by dropping ` +
                    `${reclaim.dropped} low-value tool result(s)` +
                    (reclaim.droppedPreviews.length ? ` (e.g. ${reclaim.droppedPreviews[0]})` : '')
                );
                if (reclaim.droppedPreviews.length) {
                    getOutputChannel().appendLine(
                        `[Nikas] Context budget: reclaimed ~${reclaimedTokens.toLocaleString()} tokens from low-value tool output (${reclaim.dropped} result(s))`
                    );
                }
                // Use the reclaimed list as the new "other messages".
                otherMessages.length = 0;
                otherMessages.push(...(reclaim.messages as DeepSeekMessage[]));
                const reclaimedTotal = estimateMessageTokens(
                    [...systemMessages, ...otherMessages],
                    sessionKey
                );
                if (reclaimedTotal <= availableInputTokens) {
                    // Reclaim got us under budget — repair + return.
                    const repaired = repairTruncatedSequence(systemMessages, otherMessages);
                    const finalSeq = ensureUserMessage(repaired, otherMessages);
                    const newFill = Math.round((reclaimedTotal / availableInputTokens) * 100);
                    logContextHealth(reclaimedTotal, availableInputTokens, newFill);
                    return finalSeq;
                }
            }
        }
    }

    // Hard per-request input limit (API ceiling minus output + safety). A
    // single message may exceed the SOFT budget (the configured window) yet
    // still be sendable — dropping it would blind the model to its most recent
    // work. We only drop when it cannot fit under the HARD ceiling.
    const hardInputLimit = API_TOTAL_CEILING - maxOutputTokens - API_CEILING_SAFETY;

    // Need to truncate. Keep system message, then keep the most recent messages.
    const keptMessages: DeepSeekMessage[] = [];
    let tokenBudget = availableInputTokens - estimateMessageTokens(systemMessages, sessionKey);
    let oversizedKept = false;

    for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgTokens = estimateMessageTokens([msg], sessionKey);
        if (msgTokens <= tokenBudget) {
            keptMessages.unshift(msg);
            tokenBudget -= msgTokens;
        } else if (keptMessages.length === 0) {
            // The newest message alone exceeds the remaining budget. Dropping
            // it would leave the model with an empty window (it couldn't even
            // see the latest content), which is strictly worse than sending
            // it — unless it is so large it can never fit under the API's
            // hard ceiling.
            if (msgTokens <= hardInputLimit) {
                keptMessages.unshift(msg);
                oversizedKept = true;
                tokenBudget = 0;
                // If it is a tool result, also keep its assistant tool_calls
                // caller so `repairTruncatedSequence` doesn't orphan it (a
                // tool result without its caller gets repaired away).
                if (msg.role === 'tool' && msg.tool_call_id) {
                    const caller = otherMessages[i - 1];
                    if (
                        caller?.role === 'assistant' &&
                        caller.tool_calls?.some(tc => tc.id === msg.tool_call_id)
                    ) {
                        keptMessages.unshift(caller);
                    }
                }
                // Keep the nearest preceding user turn too, so the leading
                // non-user strip in `repairTruncatedSequence` doesn't remove
                // the whole kept group.
                const keptStart = otherMessages.length - keptMessages.length;
                for (let j = keptStart - 1; j >= 0; j--) {
                    if (otherMessages[j].role === 'user') {
                        keptMessages.unshift(otherMessages[j]);
                        break;
                    }
                }
            } else {
                // Message alone exceeds even the hard ceiling — drop it and
                // everything older (they can never fit either).
                break;
            }
        } else {
            // Message doesn't fit and we already have newer content — stop.
            break;
        }
    }

    const truncated = repairTruncatedSequence(systemMessages, keptMessages);

    // Identify what the model just "forgot": messages present in the input
    // that are not in the final (truncated + repaired) sequence.
    const keptSet = new Set<DeepSeekMessage>(truncated);
    const dropped = messages.filter(m => !keptSet.has(m));

    // Guarantee a user message survives (see ensureUserMessage). Without it,
    // a pure tool-call window has no `user` turn and the Responses API would
    // receive an empty `input` (system hoisted to instructions) → HTTP 400
    // "Input items array must not be empty".
    const finalSeq = ensureUserMessage(truncated, otherMessages);

    if (oversizedKept) {
        const keptTokens = estimateMessageTokens(keptMessages, sessionKey);
        log.warn(
            `Oversized single message kept beyond budget ` +
            `(~${keptTokens.toLocaleString()} est tokens) — the window is ` +
            `dominated by one message; earlier context was dropped. If answers ` +
            `look confident-but-wrong, the missing context is why.`
        );
    }

    logContextHealth(estimatedTokens, availableInputTokens, fillPercent, dropped);

    return finalSeq;
}

/**
 * Compaction-aware context management.
 *
 * DeepSeek's coding reliability degrades past a few hundred K REAL tokens of
 * ACTIVE context (attention degradation / "lost in the middle" — users
 * consistently report ~220-300K, and the Nikas harness field baseline
 * measured precision loss from ~300K). A 512K/950K window preset lets the
 * conversation grow past that cliff, and blind truncation (dropping the
 * oldest) then causes hallucination about forgotten facts.
 *
 * So when the conversation exceeds the reliability limit
 * (`nikas.contextReliabilityLimit`, default 256K real tokens), the OLDEST
 * messages are COMPACTED into a session-memory summary instead of being sent
 * raw. The model keeps the newest turns verbatim (the active task) plus a
 * compressed record of everything earlier: the active window stays under the
 * cliff, early facts survive in summarized form, and a session can span far
 * more than 256K of work.
 *
 * Compaction fires at whichever comes first: the reliability limit on big
 * windows (keeps the active window under the attention cliff) OR the
 * configured window's available input on small windows (so auto-compact works
 * even on a 256K preset, replacing blind truncation instead of bailing to
 * it).
 *
 * Deterministic per request: the provider is stateless (VS Code re-sends the
 * original history every turn), so the same input yields the same compacted
 * sequence. The summary itself is a model call but is cached in
 * src/context/compact.ts and recomputed lazily as the old block grows.
 *
 * Returns the input unchanged when compaction does not apply: limit 0
 * (disabled), conversation under the limit, old block too small to matter,
 * no clean user boundary to snap to, the summarizer failed (fall back to
 * truncation), or the compacted result would still not fit the window.
 */
async function maybeCompactContext(
    messages: DeepSeekMessage[],
    apiKey: string,
    token: vscode.CancellationToken | undefined,
    sessionKey?: string
): Promise<DeepSeekMessage[]> {
    const reliabilityLimit = getContextReliabilityLimit();
    if (reliabilityLimit <= 0) return messages;

    // The compacted result must fit BOTH the reliability limit (keep the active
    // window under DeepSeek's attention cliff on big windows) AND the configured
    // context window (otherwise truncation would immediately undo it). Cap the
    // budget at the SMALLER of the two so auto-compact works on ANY window size
    // — including a 256K window where available input (~244K) sits below the
    // 256K reliability limit — instead of falling through to blind truncation.
    const availableInput = Math.max(
        1024,
        getContextWindowTokens() - getMaxTokens() - 1024
    );
    const budgetCap = Math.min(reliabilityLimit, availableInput);

    // The reliability limit is specified in REAL tokens (config.ts), but the
    // estimator undercounts dense workloads (code/JSON/base64 run ~1.2x real).
    // The per-session density ratio (observed API prompt_tokens vs our
    // estimate — see getDensityRatio) corrects the decision into real-token
    // space; without it compaction fires ~20% late, past the reliability
    // cliff it exists to avoid.
    const density = getDensityRatio(sessionKey);
    const estimated = Math.ceil(estimateMessageTokens(messages, sessionKey) * density);
    if (estimated <= budgetCap) {
        log.verbose(`[compact] skipped: estimated ${estimated} real (density ${density.toFixed(2)}) <= budgetCap ${budgetCap}`);
        return messages;
    }

    const system = messages.length > 0 && messages[0].role === 'system' ? [messages[0]] : [];
    const others = messages.slice(system.length);

    // Reserve headroom for the summary message.
    const summaryOverhead = SUMMARY_MAX_TOKENS + 1024;
    const keepBudget = budgetCap - Math.ceil(estimateMessageTokens(system, sessionKey) * density) - summaryOverhead;
    if (keepBudget < 1024) {
        log.verbose(`[compact] skipped: keepBudget ${keepBudget} < 1024 (system+overhead exceed budgetCap)`);
        return messages;
    }

    // Compute the split from the AGGREGATE estimate, landing on a USER-TURN
    // boundary so the kept suffix starts at a real user message (never
    // mid-tool-call). Walk the user-turn boundaries from the oldest and pick
    // the smallest old block whose kept suffix fits the budget, measured with
    // the SAME aggregate estimator as the budget check. This guarantees a
    // non-empty old block whenever `estimated > budgetCap`, because the budget
    // check and the split now use one consistent measure. (Previously the split
    // was decided by summing PER-MESSAGE estimates, which under-count vs the
    // aggregate — so the loop could "fit everything" and never produce an old
    // block, silently skipping compaction even at 400K context. This was the
    // root cause.)
    const userBoundaries: number[] = [];
    for (let i = 0; i < others.length; i++) {
        if (others[i].role === 'user') userBoundaries.push(i);
    }
    let splitIdx = -1;
    for (const i of userBoundaries) {
        if (Math.ceil(estimateMessageTokens(others.slice(i), sessionKey) * density) <= keepBudget) {
            splitIdx = i;
            break;
        }
    }
    if (splitIdx <= 0) {
        // No user boundary yields a kept suffix within budget — either a single
        // newest user turn (plus following tool group) is too large to fit, or
        // there are no user messages. Cannot compact meaningfully; fall through
        // to truncation.
        log.verbose(`[compact] skipped: no user-turn boundary reaches budget (splitIdx=${splitIdx})`);
        return messages;
    }

    const oldBlock = others.slice(0, splitIdx);
    const keep = others.slice(splitIdx);

    if (oldBlock.length < MIN_COMPACT_BLOCK) {
        log.verbose(`[compact] skipped: oldBlock ${oldBlock.length} < MIN_COMPACT_BLOCK ${MIN_COMPACT_BLOCK}`);
        return messages;
    }

    // Build the compacted summary (cached; falls back to no-op on failure).
    let summary: string;
    try {
        const abort = new AbortController();
        const cancel = token?.onCancellationRequested(() => abort.abort());
        try {
            summary = await getOrCreateSummary(apiKey, oldBlock, abort.signal);
        } finally {
            cancel?.dispose();
        }
    } catch (err) {
        log.warn(
            `Context compaction failed — falling back to truncation: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
        return messages;
    }

    const summaryText =
        `[Session memory — the earlier part of this conversation was compacted to keep ` +
        `the model reliable. Treat it as background context; it is NOT a new request. ` +
        `Rules and conventions in this block apply ONLY to the exact file/function/` +
        `feature they are attached to in the summary — do NOT extend them to unrelated ` +
        `code, and do NOT invent requirements that are not explicitly written here. ` +
        `The active task is in the newest messages below.]\n\n` +
        summary;

    // Persist this summary so a reopened conversation (after restart) can regain
    // context. Additive + best-effort; never affects the request.
    if (sessionKey) {
        try { void persistSessionMemory(sessionKey, summary, 'compaction'); } catch { /* additive */ }
    }

    // Merge the summary into the first kept user message when possible (keeps
    // the sequence valid — no consecutive user messages, leading user intact).
    let head: DeepSeekMessage[] = [{ role: 'user', content: summaryText }];
    if (keep.length > 0 && keep[0].role === 'user') {
        const first = { ...keep[0] };
        first.content = `${summaryText}\n\n---\n\n${messageText(first)}`;
        keep[0] = first;
        head = [];
    }

    const compacted = repairTruncatedSequence(system, [...head, ...keep]);
    const finalSeq = ensureUserMessage(compacted, others);

    // Safety net: if the compacted result still can't fit the window (e.g. a
    // large summary or a snapped boundary pushed it over), let truncation
    // handle it — but this is now rare since the keep budget is capped at
    // availableInput above.
    if (Math.ceil(estimateMessageTokens(finalSeq, sessionKey) * density) > availableInput) {
        log.verbose(`Compaction skipped — compacted result still exceeds the context window`);
        return messages;
    }

    const sessionLabel = sessionKey ?? 'none';
    const anchorPreview = messagePreview(oldBlock[0], 60).replace(/\s+/g, ' ').trim();
    getOutputChannel().appendLine(
        `[Nikas] Context compacted at ~${estimated.toLocaleString()} real tokens ` +
        `(reliability limit ${reliabilityLimit.toLocaleString()}, density ${density.toFixed(2)}): ${oldBlock.length} oldest ` +
        `message(s) summarized into session memory; ${finalSeq.length} message(s) sent ` +
        `[session=${sessionLabel} anchor="${anchorPreview}"]`
    );
    log.info(
        `Context compacted: ~${estimated.toLocaleString()} → ~${Math.ceil(estimateMessageTokens(finalSeq, sessionKey) * density).toLocaleString()} ` +
        `real tokens (${oldBlock.length} messages summarized, session=${sessionLabel}, limit ${reliabilityLimit.toLocaleString()}, density ${density.toFixed(2)})`
    );

    return finalSeq;
}

/**
 * Guarantee a repaired sequence always contains a usable user message.
 *
 * After truncation + repair the window can end up system-only: a pure
 * tool-call loop (no `user` turn in the kept window) makes the leading
 * non-user strip in `repairTruncatedSequence` remove everything. DeepSeek
 * rejects such requests — the Responses API hoists the system message to
 * top-level `instructions` and 400s with "Input items array must not be
 * empty"; chat completions reject non-user-first / user-less sequences.
 *
 * Re-injects the most recent real user turn from the pre-truncation
 * conversation (so the model still knows what was asked), or a minimal
 * placeholder when none exists. Fills an existing empty-content user message
 * in place when the window kept one.
 */
function ensureUserMessage(
    seq: DeepSeekMessage[],
    originalOthers: DeepSeekMessage[]
): DeepSeekMessage[] {
    if (seq.some(m => m.role === 'user' && messageText(m).trim() !== '')) {
        return seq;
    }

    const newestUser = [...originalOthers]
        .reverse()
        .find(m => m.role === 'user' && messageText(m).trim() !== '');
    const injected: DeepSeekMessage = newestUser ?? { role: 'user', content: 'Continue.' };

    const userIdx = seq.findIndex(m => m.role === 'user');
    if (userIdx >= 0) {
        // Window kept an empty-content user message — fill it in place so the
        // sequence order stays valid.
        const copy = [...seq];
        copy[userIdx] = { ...injected };
        return copy;
    }

    // No user message at all — insert right after the leading system messages.
    const firstNonSystem = seq.findIndex(m => m.role !== 'system');
    const copy = [...seq];
    if (firstNonSystem === -1) copy.push(injected);
    else copy.splice(firstNonSystem, 0, injected);
    return copy;
}

/**
 * Repair a message window so it is a VALID DeepSeek conversation:
 *   - no `assistant` message with `tool_calls` as the last message (its tool
 *     results were truncated away) — drop it
 *   - no orphaned `tool` results whose preceding `assistant tool_calls` was
 *     dropped — drop them
 *   - the first non-system message must be `user` (not assistant/tool) — drop
 *     leading assistant/tool messages until a user message leads
 * Returns the repaired sequence (never empty when the input had messages).
 */
function repairTruncatedSequence(
    systemMessages: DeepSeekMessage[],
    kept: DeepSeekMessage[]
): DeepSeekMessage[] {
    const result = [...kept];

    // 1. Drop trailing dangling tool groups: an `assistant` with `tool_calls`
    //    at the very end has no following tool results → invalid. Also drop
    //    trailing `tool` results whose assistant tool_calls was dropped.
    while (result.length > 0) {
        const last = result[result.length - 1];
        if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
            result.pop(); // dangling tool_calls with no results
            continue;
        }
        if (last.role === 'tool') {
            // Is this tool result's assistant tool_calls still in the window?
            const callerId = last.tool_call_id;
            const hasCaller = result.slice(0, -1).some(m =>
                m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === callerId)
            );
            if (!hasCaller) {
                result.pop(); // orphaned tool result
                continue;
            }
        }
        break;
    }

    // 2. Drop leading non-user messages (assistant/tool) so the conversation
    //    starts with system/user as DeepSeek requires.
    while (result.length > 0 && result[0].role !== 'user') {
        result.shift();
    }

    return [...systemMessages, ...result];
}

// ── Duplicate internal-request suppression ───────────────────────────────
// VS Code/Copilot fires the SAME tiny internal helper request twice ~8ms
// apart at session start (identical "Sending ..." pairs in nikas.log, e.g.
// tools=0, ~2KB). Both previously hit the DeepSeek API (2 paid calls + 2
// thinking-token burns per session). We detect a byte-identical request that
// is tools=0 and tiny and already in flight within a short window, then
// REPLAY the first response into the duplicate's progress instead of calling
// DeepSeek again. Real agent turns (tools>0 or larger bodies) never dedupe.
interface DedupRun {
    startedAt: number;
    bodyBytes: number;
    parts: vscode.LanguageModelResponsePart[];
    promise: Promise<void>;
    done: boolean;
}
const dedupRuns = new Map<string, DedupRun>();
const DEDUP_WINDOW_MS = 2_000;
const DEDUP_MAX_BODY_BYTES = 4_096;

/** Cheap deterministic hash of the full serialized request (FNV-1a). */
function dedupFingerprint(request: unknown): string {
    let h = 0x811c9dc5;
    const s = safeStringify(request);
    for (let i = 0; i < s.length; i++) {
        h = (h ^ s.charCodeAt(i)) * 0x01000193;
    }
    return (h >>> 0).toString(16);
}

/** Only tiny, tool-less internal helper requests are eligible for dedupe. */
function dedupEligible(toolsCount: number, bodyBytes: number): boolean {
    return toolsCount === 0 && bodyBytes > 0 && bodyBytes <= DEDUP_MAX_BODY_BYTES;
}

type DedupResult =
    | { outcome: 'duplicate' } // caller must return — response already replayed
    | { outcome: 'primary'; settle: () => void }; // caller must settle() in finally

/**
 * Register this request as the primary run (wrapping progress to capture every
 * reported part) — or, if a byte-identical request is already in flight within
 * the window, await it and replay its captured parts into `progress`.
 */
async function beginDedup(
    key: string | undefined,
    bodyBytes: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
): Promise<DedupResult> {
    if (!key) return { outcome: 'primary', settle: () => {} };

    const now = Date.now();
    const existing = dedupRuns.get(key);
    if (existing && existing.bodyBytes === bodyBytes && now - existing.startedAt <= DEDUP_WINDOW_MS) {
        // Duplicate: await the primary (if still streaming), then replay.
        if (!existing.done) await existing.promise;
        for (const part of existing.parts) progress.report(part);
        return { outcome: 'duplicate' };
    }

    // Stale or first-seen: become the primary run.
    dedupRuns.delete(key);
    // Prune entries older than the window so the map stays bounded.
    for (const [k, r] of dedupRuns) {
        if (now - r.startedAt > DEDUP_WINDOW_MS) dedupRuns.delete(k);
    }

    let resolve!: () => void;
    const promise = new Promise<void>((res) => { resolve = res; });
    const captured: vscode.LanguageModelResponsePart[] = [];
    const run: DedupRun = { startedAt: now, bodyBytes, parts: captured, promise, done: false };
    dedupRuns.set(key, run);

    // Self-heal: if the primary never reaches its finally (pathological early
    // throw), settle it after the window so a waiting duplicate can never hang
    // forever. Redundant when settle() runs normally — resolve() is a no-op
    // on an already-resolved promise.
    const watchdog = setTimeout(() => {
        if (!run.done) { run.done = true; resolve(); }
    }, DEDUP_WINDOW_MS);
    watchdog.unref?.();

    // Capture every part this request reports so a duplicate can replay it.
    const progressObj = progress as unknown as { report(p: vscode.LanguageModelResponsePart): void };
    const originalReport = progressObj.report.bind(progressObj);
    progressObj.report = (part) => {
        captured.push(part);
        originalReport(part);
    };

    return {
        outcome: 'primary',
        settle: () => { run.done = true; resolve(); },
    };
}

/**
 * NikasChatProvider — a VS Code LanguageModelChatProvider bringing multiple
 * model families under the single "Nikas" vendor.
 *
 * - DeepSeek V4 Flash & Pro → proxied to DeepSeek API
 * - Gemini 2.5 Flash & Flash-Lite → proxied to Gemini API
 * - Gemma 4 (Ollama) → proxied to local Ollama
 *
 * Registered via vscode.lm.registerLanguageModelChatProvider('nikas', provider).
 * All models appear in Copilot Chat's model picker under "Nikas".
 */
export class NikasChatProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
    private readonly secrets: SecretStore;
    /** Loaded build version — stamped on every request log line for diagnosability. */
    private readonly buildVersion: string;

    constructor(context: vscode.ExtensionContext) {
        this.secrets = new SecretStore(context.secrets);
        const version: unknown = context.extension.packageJSON?.version;
        this.buildVersion = String(version ?? 'unknown');
    }

    /** Expose key check so the extension can prompt on startup. */
    async getApiKey(): Promise<string | undefined> {
        return this.secrets.getDeepSeekApiKey();
    }

    /**
     * Handle Copilot's "Compact Conversation" / `/compact` request silently.
     *
     * Copilot sends the entire conversation with a verbose "summarize
     * everything" system prompt. Instead of forwarding that to DeepSeek (slow,
     * costly, produces a big summary response), we compact the conversation
     * using the SAME session-memory summarizer as auto-compact
     * (`getOrCreateSummary`): fast, cached, thinking-off. The returned summary
     * is reported as the single text part, and the request completes without a
     * normal model call.
     *
     * Returns the compacted session-memory summary text.
     */
    private async handleCopilotCompactRequest(
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        token: vscode.CancellationToken | undefined
    ): Promise<string> {
        const apiKey = await this.secrets.getDeepSeekApiKey();
        if (!apiKey) {
            throw new Error(
                'DeepSeek API key not configured. Run "Nikas: Input Deepseek userToken" from the command palette (F1).'
            );
        }

        // Drop the C5n "summarize everything" system message and the trailing
        // "Summarize the conversation history so far" user message — only the
        // real conversation history should be compacted.
        const conversation = messages.filter((msg) => {
            const text = msg.content
                .map((part) => vscodePartText(part))
                .join(' ');
            return (
                !text.includes(COPILOT_COMPACT_SYSTEM_MARKER) &&
                !text.includes(COPILOT_COMPACT_USER_MARKER)
            );
        });

        const deepseekMessages = await vscodeMessagesToDeepSeek(conversation);

        const abort = new AbortController();
        const cancel = token?.onCancellationRequested(() => abort.abort());
        try {
            const summary = await getOrCreateSummary(apiKey, deepseekMessages, abort.signal);
            // Persist so a reopened conversation regains context after a restart.
            try {
                const sessionKey = getSessionKeyFromDeepSeek(deepseekMessages);
                if (sessionKey) void persistSessionMemory(sessionKey, summary, 'compact-command');
            } catch { /* additive */ }
            log.info(
                `Copilot "Compact Conversation" handled silently via session-memory summarizer ` +
                `(${deepseekMessages.length} messages → summary)`
            );
            getOutputChannel().appendLine(
                `[Nikas] Compact Conversation handled silently via session-memory summarizer ` +
                `(${deepseekMessages.length} messages → summary)`
            );
            return summary;
        } finally {
            cancel?.dispose();
        }
    }

    /** Expose Gemini key check for internal use. */
    private async getGeminiApiKey(): Promise<string | undefined> {
        return this.secrets.getGeminiApiKey();
    }

    /**
     * Returns the list of available models. Called by VS Code when the model picker opens.
     * Shows all configured models under the single "Nikas" vendor.
     *
     * - DeepSeek models: require DeepSeek API key
     * - Gemini models: require Gemini API key
     * - Gemma 4: always available (local Ollama, no key needed)
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const models: ModelPickerChatInformation[] = [];
        const deepseekKey = await this.secrets.getDeepSeekApiKey();
        const geminiKey = await this.secrets.getGeminiApiKey();

        // ── DeepSeek models ──────────────────────────────────────────
        if (deepseekKey) {
            const effectiveInputTokens = getContextWindowTokens();
            const effectiveOutputTokens = getMaxTokens();
            for (const m of DEEPSEEK_MODELS) {
                const modelInfo: ModelPickerChatInformation = {
                    id: m.id,
                    name: m.name,
                    family: m.family,
                    version: m.version,
                    maxInputTokens: Math.min(m.maxInputTokens, effectiveInputTokens),
                    maxOutputTokens: Math.min(m.maxOutputTokens, effectiveOutputTokens),
                    capabilities: withEditTools(m.capabilities) as vscode.LanguageModelChatInformation['capabilities'],
                    detail: m.detail,
                };

                // Both Flash and Pro support thinking — add the per-model
                // Thinking Effort + temperature dropdown in the model picker
                // (matches upstream Nika + C-8 v0.7.88).
                modelInfo.configurationSchema = buildThinkingEffortSchema();

                models.push(modelInfo);
            }

            // Responses API model (flash only) — picked via the Copilot picker,
            // intentionally NOT part of DEEPSEEK_MODELS / nikas.selectedModel so
            // the chat-completions handler can never be told to send this id.
            const responsesModelInfo: ModelPickerChatInformation = {
                id: DEEPSEEK_RESPONSES_MODEL.id,
                name: DEEPSEEK_RESPONSES_MODEL.name,
                family: DEEPSEEK_RESPONSES_MODEL.family,
                version: DEEPSEEK_RESPONSES_MODEL.version,
                maxInputTokens: Math.min(DEEPSEEK_RESPONSES_MODEL.maxInputTokens, effectiveInputTokens),
                maxOutputTokens: Math.min(DEEPSEEK_RESPONSES_MODEL.maxOutputTokens, effectiveOutputTokens),
                capabilities: withEditTools(DEEPSEEK_RESPONSES_MODEL.capabilities) as vscode.LanguageModelChatInformation['capabilities'],
                detail: DEEPSEEK_RESPONSES_MODEL.detail,
            };
            responsesModelInfo.configurationSchema = buildThinkingEffortSchema();
            models.push(responsesModelInfo);
        } else if (!options.silent) {
            vscode.window.showWarningMessage(
                'Nikas: DeepSeek API key not configured. DeepSeek models will not appear in the model picker until the key is set.'
            );
        }

        // ── Gemini models ────────────────────────────────────────────
        if (geminiKey) {
            models.push(
                {
                    id: 'gemini-2.5-flash',
                    name: 'Gemini 2.5 Flash',
                    family: 'gemini',
                    version: '2.5.0',
                    maxInputTokens: 1_000_000,
                    maxOutputTokens: 8_192,
                    capabilities: { imageInput: true },
                    detail: 'Google Gemini 2.5 Flash — free tier',
                    isBYOK: true,
                },
                {
                    id: 'gemini-2.5-flash-lite',
                    name: 'Gemini 2.5 Flash-Lite',
                    family: 'gemini',
                    version: '2.5.0',
                    maxInputTokens: 1_000_000,
                    maxOutputTokens: 8_192,
                    capabilities: { imageInput: true },
                    detail: 'Google Gemini 2.5 Flash-Lite — fastest, most cost-efficient',
                    isBYOK: true,
                }
            );
        } else if (!options.silent && !deepseekKey) {
            // Only show one warning if neither key is set
            vscode.window.showWarningMessage(
                'Nikas: Gemini API key not configured. Gemini models will not appear in the model picker until the key is set.'
            );
        }

        // ── Gemma 4 (always available, local Ollama) ─────────────────
        models.push({
            id: 'gemma4:31b',
            name: 'Gemma 4 (Ollama)',
            family: 'gemma',
            version: '4.0.0',
            maxInputTokens: 128_000,
            maxOutputTokens: 4_096,
            capabilities: { imageInput: true },
            detail: 'Local Gemma 4 via Ollama — runs on your machine',
            isBYOK: true,
        });

        return models;
    }

    /**
     * Handle a chat request. Routes to the correct handler based on model ID.
     *
     * - deepseek-* → DeepSeek API (with vision preprocessing + replay markers)
     * - gemini-*   → Gemini API directly
     * - gemma4:*   → Ollama API directly
     */
    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Copilot's "Compact Conversation" button / `/compact` command sends the
        // ENTIRE conversation with a verbose "summarize everything" system
        // prompt. Handle it SILENTLY with our own session-memory summarizer
        // (same machinery as auto-compact: fast, cached, thinking-off) instead
        // of shipping the whole context to DeepSeek for a full model call. This
        // is intercepted before routing, so it applies to whichever Nikas model
        // is selected for the chat (compaction runs through the user's model).
        if (isCopilotCompactRequest(messages)) {
            const summary = await this.handleCopilotCompactRequest(messages, token);
            if (token.isCancellationRequested) return;
            progress.report(new vscode.LanguageModelTextPart(summary));
            return;
        }

        // Route to the appropriate handler
        if (model.id.startsWith('gemini-')) {
            return this.handleGeminiChat(model.id, messages, progress, token);
        }
        if (model.id.startsWith('gemma4:')) {
            return this.handleGemma4Chat(model.id, messages, progress, token);
        }
        if (model.id === DEEPSEEK_RESPONSES_MODEL.id) {
            return this.handleDeepSeekResponsesChat(model.id, messages, options, progress, token);
        }

        // ── DeepSeek handler (inline, for minimal diff) ──────────────
        const apiKey = await this.secrets.getDeepSeekApiKey();
        if (!apiKey) {
            throw new Error(
                'DeepSeek API key not configured. Run "Nikas: Input Deepseek userToken" from the command palette (F1).'
            );
        }

        // Check for cancellation
        if (token.isCancellationRequested) return;
        const startedAt = Date.now();

        // Resolve images to text descriptions (replay markers / vision model)
        // This operates on raw VS Code messages BEFORE conversion to DeepSeek format.
        // Wrap in try-catch so a describer failure doesn't crash the whole request.
        const getDescriber = async () => {
            try {
                return await this.createVisionDescriber();
            } catch (err) {
                visionLog.error('Failed to create vision describer', err);
                return undefined;
            }
        };
        const visionResolution = await resolveImageMessages(messages, token, getDescriber);
        let resolvedMessages = visionResolution.messages;
        const replayMarkerMetadata = visionResolution.replayMarkerMetadata;

        // Sparse-PDF vision enrichment: image-based / scanned / drawing-heavy
        // PDFs yield little extracted text, so describe them via Gemini (which
        // reads application/pdf natively) and append the visual description.
        resolvedMessages = await resolveSparsePdfVision(resolvedMessages, token, getDescriber);

        // Log vision stats for diagnostics
        if (visionResolution.stats.inputImageParts > 0) {
            const s = visionResolution.stats;
            visionLog.info(
                `Vision: ${s.inputImageParts} attachment(s) in ${s.inputImageMessages} message(s) ` +
                `→ current=${s.currentImageMessages} generated=${s.generatedImageMessages} ` +
                `replayed=${s.replayedImageMessages} omitted=${s.omittedImageMessages} ` +
                `unavailable=${s.unavailableImageMessages} failed=${s.failedImageMessages} ` +
                `[session=${visionResolution.sessionKey ?? 'none'}]`
            );
        }

        // Show any vision notices to the user
        if (visionResolution.initialResponseNotice) {
            progress.report(new vscode.LanguageModelTextPart(
                `\n\n${visionResolution.initialResponseNotice}\n\n`
            ));
        }

        if (token.isCancellationRequested) return;

        // Convert resolved VS Code messages to DeepSeek format
        let deepseekMessages = await vscodeMessagesToDeepSeek(resolvedMessages);

        // Per-conversation identity for adaptive calibration. Derived from the
        // ORIGINAL history (before compaction replaces the oldest turns with a
        // summary) so it stays stable across turns and distinct across chats.
        const sessionKey = getSessionKeyFromDeepSeek(deepseekMessages);
        // Report the active conversation to the usage UI (status bar / dashboard).
        setCurrentSessionKey(sessionKey);
        // Human-readable label for the per-session view — first user turn.
        const sessionLabel = (() => {
            for (const m of deepseekMessages) {
                if (m.role === 'user') return messagePreview(m, 60);
            }
            return undefined;
        })();

        // Re-inject persisted session memory (from a prior session of this same
        // conversation) so a reopened chat regains context after a restart.
        // Additive + best-effort; no-op when there's nothing saved or already present.
        deepseekMessages = injectPersistentMemory(deepseekMessages, sessionKey);

        // Compact the oldest messages into session memory when the conversation
        // crosses the reliability limit (see maybeCompactContext), THEN truncate
        // to the configured window as a safety net.
        deepseekMessages = await maybeCompactContext(deepseekMessages, apiKey, token, sessionKey);

        // Truncate messages to fit within the configured context window
        deepseekMessages = truncateMessagesToContextWindow(deepseekMessages, sessionKey);

        // Optionally inject the agent directive (chat-completions path). The
        // directive reinforces persistent, action-first agent behavior WITHOUT
        // reducing the tool set.
        const systemSuffix =
            getConcisePrompt() ? `\n\n${CONCISE_PROMPT_DIRECTIVE}` : '';
        if (systemSuffix && deepseekMessages.length > 0) {
            const first = deepseekMessages[0];
            if (first.role === 'system') {
                const base = typeof first.content === 'string'
                    ? first.content
                    : Array.isArray(first.content)
                        ? first.content.map(p => p.type === 'text' ? p.text : '').join('')
                        : '';
                first.content = `${base}${systemSuffix}`;
            } else {
                // No leading system message — prepend one carrying the directives
                // so the agent behavior is enforced even without a system turn
                // (mirrors the Responses path, which always sets instructions).
                deepseekMessages.unshift({ role: 'system', content: systemSuffix.trim() });
            }
        }

        if (token.isCancellationRequested) return;

        // Ground-truth estimate of what we're about to send — fed back into
        // the adaptive calibration on completion so truncation timing stays
        // honest for this workload.
        const estimatedSentTokens = estimateMessageTokens(deepseekMessages, sessionKey);

        // Build the API request
        const config = getConfig();

        // Read thinking effort from the model-picker dropdown first (set by
        // Copilot Chat's Thinking Effort dropdown, matching upstream Nika),
        // falling back to the saved nikas.thinkingEffort setting. Per-agent
        // overrides (nikas.agentEfforts) let Plan/Explore/Inline/helpers carry
        // their own effort.
        const requestKind = classifyProviderRequest({ messages, tools: options.tools, initiator: getRequestInitiator(options) });
        const kindId = requestKind.kind;

        let modelId = getSelectedModel();

        // v0.7.84/85 model router: optionally route cheap internal helpers to
        // the cheaper Flash model when Pro is selected (nikas.modelRouter, OFF
        // by default). Auto mode (nikas.modelRouterMode) additionally routes
        // heavy agent tasks to Pro and quick chats to Flash. Never routes the
        // Responses model id to /chat/completions.
        const route = decideDeepSeekRoute(kindId, modelId, getModelRouter(), getModelRouterMode(), options.tools?.length ?? 0, getModelRouterKinds());
        if (route.modelId && route.modelId !== modelId) {
            getOutputChannel().appendLine(`[Nikas] Model router: ${modelId} → ${route.modelId} (${route.reason})`);
            modelId = route.modelId;
        }

        // Log which model is being used — detect agent type from modelOptions
        const agentName = options.modelOptions?.['agent']
            ?? options.modelOptions?.['agentName']
            ?? options.modelOptions?.['mode']
            ?? options.modelOptions?.['subagent']
            ?? '';
        const isSubagent = !!(options.modelOptions?.['subagent']
            || options.modelOptions?.['_subagent']
            || (options.modelOptions?.['agentName'] && options.modelOptions?.['agentName'] !== options.modelOptions?.['mode']));
        const agentType = isSubagent ? 'subagent' : (agentName ? `agent` : 'direct');
        const agentLabel = agentName ? ` [${agentType}: ${agentName}]` : '';
        const msg = `[Nikas] Using model: ${modelId}${agentLabel}`;
        console.log(msg);
        getOutputChannel().appendLine(msg);

        const ctxWindowTokens = getContextWindowTokens();
        getOutputChannel().appendLine(`[Nikas] Context window: ${ctxWindowTokens.toLocaleString()} tokens (setting: ${getContextWindowPreset()})`);

        const baseEffort = getRequestThinkingEffort(options);
        // C-9 (v0.7.88): a per-model thinking default (nikas.modelThinkingDefaults)
        // overrides the global effort for this model. Agent-effort overrides
        // (resolveAgentEffort) still take precedence via the kind.
        const modelEffort = getModelThinkingDefault(modelId) ?? baseEffort;
        const { effort: thinkingEffort, source: effortSource } = resolveAgentEffort(kindId, modelEffort);
        const thinkingParams = buildThinkingParams(thinkingEffort);

        // Log which effort is being used
        getOutputChannel().appendLine(
            `[Nikas] Thinking effort: ${thinkingEffort}` +
            (effortSource === 'agent-effort' ? ` (agent: ${requestKindToAgentKind(kindId)} — per-agent effort)` : '')
        );
        if (effortSource === 'agent-effort') {
            log.verbose(`Per-agent effort for ${requestKindToAgentKind(kindId)} (${kindId}) — ${thinkingEffort}`);
        }

        // When thinking mode is enabled, ensure enough headroom for reasoning
        // tokens. DeepSeek's thinking can consume 4K-16K+ tokens on reasoning
        // alone, leaving nothing for visible output if max_tokens is too low.
        // (Matches upstream Nika's boost: a 16K floor when thinking is on.)
        const effectiveMaxTokens = getMaxTokens();
        const thinkingEnabled = thinkingEffort !== 'off';
        const minThinkingTokens = 16_384;
        const boostedTokens = thinkingEnabled
            ? Math.max(effectiveMaxTokens, minThinkingTokens)
            : effectiveMaxTokens;
        if (boostedTokens !== effectiveMaxTokens) {
            getOutputChannel().appendLine(`[Nikas] Thinking mode enabled — boosting max_tokens from ` +
                `${effectiveMaxTokens.toLocaleString()} to ${boostedTokens.toLocaleString()} to leave room for reasoning`);
        }

        const request: DeepSeekRequest = {
            model: modelId,
            messages: deepseekMessages,
            temperature: getRequestTemperature(options),
            max_tokens: boostedTokens,
            stream: true,
            ...thinkingParams,
            stream_options: { include_usage: true },
        };

        // Add tools if provided in options
        if (options.tools && options.tools.length > 0) {
            logKnowledgeSummary(options.tools);
            request.tools = options.tools.map(mapTool);
            // v0.7.86 tool-description budget: in agent mode the tool schemas
            // are the biggest hidden context cost — trim long descriptions to
            // fit the budget (names/parameters untouched, tool-calling intact).
            if (getToolBudget()) {
                const trimmed = trimToolDescriptions(request.tools, { budgetTokens: getToolBudgetTokens() });
                if (trimmed.trimmed > 0) {
                    log.info(
                        `[tool-budget] trimmed ${trimmed.trimmed} description(s) ` +
                        `(~${trimmed.savedTokens} tokens freed; ${trimmed.totalTokens.toLocaleString()} → ${estimateToolTokens(trimmed.tools).toLocaleString()})`
                    );
                    request.tools = trimmed.tools;
                }
            }
            // DeepSeek supports at most 128 functions per request (upstream #77).
            assertToolsWithinLimit(request.tools, 'chat-completions');
            // Honor Copilot's toolMode: Required forces the model to call a tool
            // (stable API — "the provider must implement respecting this").
            request.tool_choice = resolveToolChoice(options.toolMode);
            if (request.tool_choice === 'required') {
                log.info(`Copilot requested toolMode=Required — forcing tool_choice='required' (model must call a tool)`);
            }
        }

        // Note (2026-08-09): the old "thinking+tools may 400" warning was
        // REMOVED — verified false. The real 400 was the missing
        // reasoning_text round-trip (fixed in v0.7.9); thinking+tools works
        // fine now. Log at verbose only for diagnostics.
        if (thinkingEnabled) {
            log.verbose(
                `Thinking mode (${thinkingEffort}) with ${options.tools?.length ?? 0} tool(s) — reasoning round-trip enabled`
            );
        }

        // Validate message sequence order before sending
        const sequenceIssues = validateMessageSequence(deepseekMessages);
        if (sequenceIssues.length > 0) {
            const warning = `[Nikas] WARNING: Message sequence validation found ${sequenceIssues.length} issue(s):\n  ${sequenceIssues.join('\n  ')}`;
            getOutputChannel().appendLine(warning);
            log.warn(warning);

            // Log the full message roles for debugging (verbose only)
            const roleSequence = deepseekMessages.map((m, i) => {
                const hasTc = m.tool_calls ? ` (${m.tool_calls.length} tool_calls)` : '';
                const isToolResult = m.tool_call_id ? ` (tool_call_id: ${m.tool_call_id})` : '';
                const contentLen = typeof m.content === 'string' ? m.content.length :
                    Array.isArray(m.content) ? m.content.length : 0;
                return `  [${i}] role=${m.role}${hasTc}${isToolResult} content=${typeof m.content === 'string' ? m.content.slice(0, 80) : contentLen > 0 ? `[${contentLen} parts]` : m.content === null ? 'null' : 'empty'}`;
            }).join('\n');
            log.verbose(`Full message role sequence (${deepseekMessages.length} messages):\n${roleSequence}`);
        }

        // Log request summary to nikas.log
        const bodySize = new TextEncoder().encode(safeStringify(request)).length;

        // Duplicate internal-request suppression: Copilot fires the same tiny
        // helper request twice ~8ms apart at session start. If this is the
        // duplicate, beginDedup replays the first response into our progress
        // and we return without calling DeepSeek again.
        const dedupKey = dedupEligible(options.tools?.length ?? 0, bodySize)
            ? dedupFingerprint(request)
            : undefined;
        const dedup = await beginDedup(dedupKey, bodySize, progress);
        if (dedup.outcome === 'duplicate') {
            log.info(
                `Duplicate internal request (model=${modelId}, tools=0, ` +
                `${(bodySize / 1024).toFixed(1)}KB) — replayed first response, skipped DeepSeek call`
            );
            return;
        }

        log.info(
            `Sending DeepSeek request: model=${modelId}, ` +
            `messages=${deepseekMessages.length}, ` +
            `tools=${options.tools?.length ?? 0}, ` +
            `bodySize=${(bodySize / 1024).toFixed(1)}KB, ` +
            `thinking=${thinkingEnabled}, ` +
            `max_tokens=${boostedTokens.toLocaleString()}, ` +
            `temperature=${getTemperature()}, ` +
            `build=v${this.buildVersion}`
        );

        // Create an AbortController for cancellation
        const abortController = new AbortController();
        // v0.7.86 TTFT: time of the first emitted text/tool chunk.
        let firstChunkAt: number | undefined;
        const cancelDisposable = token.onCancellationRequested(() => {
            // Log whether the stop came from VS Code/Copilot (agent loop) vs a
            // user Stop. A silent mid-turn stop is otherwise indistinguishable
            // from a hung stream — both log nothing today.
            log.info(
                `Chat request cancellation requested by VS Code/user (Copilot) — aborting stream. ` +
                `model=${modelId}, messages=${deepseekMessages.length}, thinking=${thinkingEnabled}`
            );
            abortController.abort();
        });

        try {
            const streamResult = await streamDeepSeekChat(
                request,
                apiKey,
                abortController.signal,
                // onText
                (text: string) => {
                    firstChunkAt ??= Date.now();
                    progress.report(new vscode.LanguageModelTextPart(text));
                },
                // onToolCalls
                (toolCalls) => {
                    firstChunkAt ??= Date.now();
                    // Passive observation: log which native tools DeepSeek actually
                    // requested so we can measure whether the knowledge enrichment
                    // steers it toward Copilot's tools. Read-only — never intercepts
                    // or changes the tool set, so Copilot's native loop is untouched.
                    if (toolCalls && toolCalls.length > 0) {
                        log.info(`[tool-req] DeepSeek requested: ${toolCalls.map(tc => tc.name).join(', ')}`);
                    }
                    for (const tc of toolCalls) {
                        progress.report(
                            new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.arguments)
                        );
                    }
                },
                // onComplete
                (usage) => {
                    // Report token usage
                    if (usage) {
                        progress.report(
                            new vscode.LanguageModelDataPart(
                                new TextEncoder().encode(
                                    JSON.stringify({
                                        prompt_tokens: usage.promptTokens,
                                        completion_tokens: usage.completionTokens,
                                        total_tokens: usage.promptTokens + usage.completionTokens,
                                    })
                                ),
                                'usage'
                            )
                        );
                        // Monitor actual usage vs the configured window
                        logUsageVsWindow(usage.promptTokens, usage.completionTokens, estimatedSentTokens, sessionKey);
                        // Account for usage/cost (additive observer — never blocks).
                        usageTracker.record({
                            provider: 'deepseek',
                            model: modelId,
                            promptTokens: usage.promptTokens,
                            completionTokens: usage.completionTokens,
                            timestamp: Date.now(),
                            latencyMs: Date.now() - startedAt,
                            ttftMs: firstChunkAt ? firstChunkAt - startedAt : undefined,
                            cacheHitTokens: usage.cacheHitTokens,
                            cacheMissTokens: usage.cacheMissTokens,
                            reasoningTokens: usage.reasoningTokens,
                            requestKind: kindId,
                            initiator: getRequestInitiator(options),
                            sessionKey,
                            sessionLabel,
                        });
                    }

                    // NOTE: the vision replay marker is NOT emitted here. It is
                    // emitted ONCE below (combined with any thinking reasoning)
                    // so a turn with both vision + thinking never produces two
                    // stateful_marker data parts — VS Code renders each unknown
                    // data part as a placeholder row, which looked like the
                    // agent's screenshot appearing twice (v0.7.92 fix).
                }
            );

            // If DeepSeek returned nothing, don't throw — VS Code's agent loop
            // handles empty responses fine. Just log it for diagnostics.
            if (!streamResult.receivedContent && !streamResult.receivedToolCalls) {
                log.info(
                    `Empty response from DeepSeek (finish_reason: ${streamResult.finishReason ?? 'none'}, ` +
                    `max_tokens: ${boostedTokens.toLocaleString()}, thinking: ${thinkingEnabled})`
                );
            }

            // Round-trip thinking-mode CoT. When tools are used with thinking
            // enabled, DeepSeek REQUIRES the reasoning_text to be passed back
            // on the next request (HTTP 400 otherwise). We attach it to the
            // replay marker so the next turn can re-inject it as
            // reasoning_content / reasoning_text.
            if (streamResult.reasoningText) {
                // Show the CoT natively in the chat UI (collapsed thinking
                // block, like Copilot's own models) where the API supports it.
                reportThinkingPart(progress, streamResult.reasoningText);
                log.verbose(
                    `Captured thinking reasoning (${streamResult.reasoningText.length} chars) for round-trip`
                );
            }

            // Inject a SINGLE replay marker when this turn described images
            // and/or captured thinking reasoning. Combining both in one part
            // prevents the "doubled image/attachment row" render bug (two
            // stateful_marker data parts → two placeholder rows in the chat
            // transcript). The marker carries vision text, reasoning text, or
            // both; replay/pipeline merge them on the next turn.
            if (replayMarkerMetadata.visionText || streamResult.reasoningText) {
                progress.report(createReplayMarkerPart({
                    ...replayMarkerMetadata,
                    reasoningText: streamResult.reasoningText,
                }));
            }
        } catch (err) {
            if (abortController.signal.aborted) {
                log.info(
                    `Chat request aborted mid-stream — turn did not complete. ` +
                    `model=${modelId}, messages=${deepseekMessages.length}, thinking=${thinkingEnabled}`
                );
                return; // Cancelled by user / VS Code — silent stop
            }
            // Build a descriptive error for VS Code's error reporting.
            // The Copilot summarizer catches errors and logs them; an opaque
            // "unknown" message makes debugging impossible. We wrap the error
            // so VS Code's ConversationHistorySummarizer gets a useful message.
            const errorMessage = err instanceof Error ? err.message : String(err || 'unknown error');
            const wrappedError = new Error(
                `Nikas provider error (model: ${modelId}): ${errorMessage}`
            );
            // Preserve the original stack if available
            if (err instanceof Error && err.stack) {
                wrappedError.stack = err.stack;
            }

            // Log to nikas.log for offline investigation
            log.error(
                `Chat request failed for model "${modelId}" (messages: ${deepseekMessages.length}, tools: ${options.tools?.length ?? 0})`,
                err
            );
            // Also log extra context that might help debug 400s
            log.verbose(
                `Error context: model=${modelId}, ` +
                `thinking=${thinkingEnabled}, ` +
                `tools=${options.tools?.length ?? 0}, ` +
                `max_tokens=${boostedTokens}, ` +
                `temperature=${getTemperature()}, ` +
                `bodySize=${(new TextEncoder().encode(safeStringify(request)).length / 1024).toFixed(1)}KB, ` +
                `contextWindow=${getContextWindowPreset()}`
            );

            // Only report to progress for interactive (non-background) requests.
            // Background summarization requests don't have a visible chat window,
            // and calling progress.report on them is harmless but unnecessary.
            progress.report(new vscode.LanguageModelTextPart(`\n\n❌ ${errorMessage}\n\n`));
            throw wrappedError;
        } finally {
            dedup.settle();
            cancelDisposable.dispose();
        }
        log.info(
            `Chat request completed: model=${modelId}, messages=${deepseekMessages.length}, thinking=${thinkingEnabled}`
        );
    }

    /**
     * Handle a chat request routed to the DeepSeek Responses API (POST /responses).
     *
     * Currently only `deepseek-v4-flash` is supported on this endpoint, so the
     * API model is always flash — regardless of `nikas.selectedModel` (which is
     * scoped to the chat-completions handler).
     *
     * Reuses the same vision pipeline, message conversion, context truncation,
     * thinking-effort dropdown, and tool mapping as the chat-completions path —
     * only the wire format / SSE parsing differs (see streamDeepSeekResponses).
     */
    private async handleDeepSeekResponsesChat(
        modelId: string,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const apiKey = await this.secrets.getDeepSeekApiKey();
        if (!apiKey) {
            throw new Error(
                'DeepSeek API key not configured. Run "Nikas: Input Deepseek userToken" from the command palette (F1).'
            );
        }

        if (token.isCancellationRequested) return;
        const startedAt = Date.now();

        // Resolve images to text descriptions (same pipeline as chat completions)
        const getDescriber = async () => {
            try {
                return await this.createVisionDescriber();
            } catch (err) {
                visionLog.error('Failed to create vision describer', err);
                return undefined;
            }
        };
        const visionResolution = await resolveImageMessages(messages, token, getDescriber);
        let resolvedMessages = visionResolution.messages;
        const replayMarkerMetadata = visionResolution.replayMarkerMetadata;

        // Sparse-PDF vision enrichment (see chat handler for rationale)
        resolvedMessages = await resolveSparsePdfVision(resolvedMessages, token, getDescriber);

        // Log vision stats for diagnostics (mirrors the chat-completions handler)
        if (visionResolution.stats.inputImageParts > 0) {
            const s = visionResolution.stats;
            visionLog.info(
                `Vision: ${s.inputImageParts} attachment(s) in ${s.inputImageMessages} message(s) ` +
                `→ current=${s.currentImageMessages} generated=${s.generatedImageMessages} ` +
                `replayed=${s.replayedImageMessages} omitted=${s.omittedImageMessages} ` +
                `unavailable=${s.unavailableImageMessages} failed=${s.failedImageMessages} ` +
                `[session=${visionResolution.sessionKey ?? 'none'}]`
            );
        }

        if (visionResolution.initialResponseNotice) {
            progress.report(new vscode.LanguageModelTextPart(
                `\n\n${visionResolution.initialResponseNotice}\n\n`
            ));
        }

        if (token.isCancellationRequested) return;

        // Convert + truncate to DeepSeek message form, then to Responses input
        let deepseekMessages = await vscodeMessagesToDeepSeek(resolvedMessages);
        // Per-conversation identity for adaptive calibration. Derived from the
        // ORIGINAL history (before compaction) so it stays stable across turns
        // and distinct across chats.
        const sessionKey = getSessionKeyFromDeepSeek(deepseekMessages);
        // Report the active conversation to the usage UI.
        setCurrentSessionKey(sessionKey);
        const sessionLabel = (() => {
            for (const m of deepseekMessages) {
                if (m.role === 'user') return messagePreview(m, 60);
            }
            return undefined;
        })();
        // Re-inject persisted session memory from a prior session of this
        // conversation (survives restarts). Additive + best-effort.
        deepseekMessages = injectPersistentMemory(deepseekMessages, sessionKey);
        // Compact the oldest messages into session memory when the conversation
        // crosses the reliability limit (see maybeCompactContext), THEN truncate
        // to the configured window as a safety net.
        deepseekMessages = await maybeCompactContext(deepseekMessages, apiKey, token, sessionKey);
        deepseekMessages = truncateMessagesToContextWindow(deepseekMessages, sessionKey);
        const { input, instructions } = deepseekMessagesToResponsesInput(deepseekMessages);

        // Ground-truth estimate of what we're about to send — fed back into
        // the adaptive calibration on completion (see chat handler rationale).
        const estimatedSentTokens = estimateMessageTokens(deepseekMessages, sessionKey);

        // Optionally inject the "no process narration" directive into the
        // instructions. (Controlled by nikas.concisePrompt.)
        const conciseDirective =
            getConcisePrompt() ? `\n\n${CONCISE_PROMPT_DIRECTIVE}` : '';

        // Thinking effort from the nikas.thinkingEffort setting. Invisible
        // internal helper requests are always forced to thinking off (see the
        // chat-completions handler for rationale). Per-agent overrides
        // (nikas.agentEfforts) apply too.
        const requestKind = classifyProviderRequest({ messages, tools: options.tools, initiator: getRequestInitiator(options) });
        const kindId = requestKind.kind;
        const baseEffort = getRequestThinkingEffort(options);
        // C-9: per-model thinking default (nikas.modelThinkingDefaults) overrides
        // the global effort; agent-effort overrides still take precedence via kind.
        const modelEffort = getModelThinkingDefault(modelId) ?? getModelThinkingDefault('deepseek-v4-flash') ?? baseEffort;
        const { effort: thinkingEffort, source: effortSource } = resolveAgentEffort(kindId, modelEffort);
        const reasoningParams = buildResponsesThinkingParams(thinkingEffort);
        const thinkingEnabled = thinkingEffort !== 'off';

        // When thinking mode is enabled, ensure enough headroom for reasoning
        // tokens — same 16K floor as upstream Nika's Responses handler.
        const effectiveMaxTokens = getMaxTokens();
        const minThinkingTokens = 16_384;
        const boostedTokens = thinkingEnabled
            ? Math.max(effectiveMaxTokens, minThinkingTokens)
            : effectiveMaxTokens;
        if (boostedTokens !== effectiveMaxTokens) {
            getOutputChannel().appendLine(`[Nikas] Thinking mode enabled — boosting max_tokens from ` +
                `${effectiveMaxTokens.toLocaleString()} to ${boostedTokens.toLocaleString()} to leave room for reasoning`);
        }

        // Log which effort is being used (mirrors the chat-completions handler)
        getOutputChannel().appendLine(
            `[Nikas] Thinking effort: ${thinkingEffort}` +
            (effortSource === 'agent-effort' ? ` (agent: ${requestKindToAgentKind(kindId)} — per-agent effort)` : '')
        );
        if (effortSource === 'agent-effort') {
            log.verbose(`Per-agent effort for ${requestKindToAgentKind(kindId)} (${kindId}) — ${thinkingEffort}`);
        }

        // E-13 (v0.7.88): optional heavy-agent promotion on the Responses API.
        // DeepSeek's Responses endpoint only officially supports flash, but docs
        // flagged Pro support arriving early Aug 2026. Gated behind
        // nikas.responsesHeavyPro (default OFF) so behavior is unchanged until
        // the user opts in and verifies Pro works on their endpoint.
        const heavyKinds = kindId === 'main-agent' || kindId === 'plan-agent' || kindId === 'explore-agent';
        const responsesApiModel =
            getResponsesHeavyPro() && heavyKinds ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
        if (responsesApiModel === 'deepseek-v4-pro') {
            getOutputChannel().appendLine(`[Nikas] Responses API: heavy ${kindId} → routed to deepseek-v4-pro (nikas.responsesHeavyPro)`);
        }

        const request: DeepSeekResponsesRequest = {
            model: responsesApiModel,
            input,
            temperature: getRequestTemperature(options),
            max_output_tokens: boostedTokens,
            stream: true,
            ...reasoningParams,
        };
        if (instructions) request.instructions = instructions + conciseDirective;
        else if (conciseDirective) request.instructions = conciseDirective.trim();

        if (options.tools && options.tools.length > 0) {
            logKnowledgeSummary(options.tools);
            request.tools = options.tools.map(mapResponsesTool);
            // v0.7.86 tool-description budget (see chat-completions site).
            if (getToolBudget()) {
                const trimmed = trimToolDescriptions(request.tools, { budgetTokens: getToolBudgetTokens() });
                if (trimmed.trimmed > 0) {
                    log.info(
                        `[tool-budget] trimmed ${trimmed.trimmed} description(s) ` +
                        `(~${trimmed.savedTokens} tokens freed; ${trimmed.totalTokens.toLocaleString()} → ${estimateToolTokens(trimmed.tools).toLocaleString()})`
                    );
                    request.tools = trimmed.tools;
                }
            }
            // DeepSeek supports at most 128 functions per request (upstream #77).
            assertToolsWithinLimit(request.tools, 'responses');
            // Honor Copilot's toolMode: Required forces the model to call a tool
            // (stable API — "the provider must implement respecting this").
            request.tool_choice = resolveToolChoice(options.toolMode);
            if (request.tool_choice === 'required') {
                log.info(`Copilot requested toolMode=Required — forcing tool_choice='required' (model must call a tool)`);
            }
        }

        // Note (2026-08-09): the old "thinking+tools may 400" warning was
        // REMOVED — verified false. The real 400 was the missing
        // reasoning_text round-trip (fixed in v0.7.9); thinking+tools works
        // fine now. Log at verbose only for diagnostics.
        if (thinkingEnabled) {
            log.verbose(
                `Thinking mode (${thinkingEffort}) with ${options.tools?.length ?? 0} tool(s) — reasoning round-trip enabled`
            );
        }

        // Log request summary
        const bodySize = new TextEncoder().encode(safeStringify(request)).length;

        // Duplicate internal-request suppression (see chat handler rationale).
        const dedupKey = dedupEligible(options.tools?.length ?? 0, bodySize)
            ? dedupFingerprint(request)
            : undefined;
        const dedup = await beginDedup(dedupKey, bodySize, progress);
        if (dedup.outcome === 'duplicate') {
            log.info(
                `Duplicate internal request (model=${modelId}, tools=0, ` +
                `${(bodySize / 1024).toFixed(1)}KB) — replayed first response, skipped DeepSeek call`
            );
            return;
        }

        log.info(
            `Sending DeepSeek Responses request: model=${modelId} (api=deepseek-v4-flash), ` +
            `inputItems=${Array.isArray(input) ? input.length : 0}, ` +
            `tools=${options.tools?.length ?? 0}, ` +
            `bodySize=${(bodySize / 1024).toFixed(1)}KB, ` +
            `thinking=${thinkingEnabled}, ` +
            `max_output_tokens=${boostedTokens.toLocaleString()}, ` +
            `temperature=${getTemperature()}, ` +
            `build=v${this.buildVersion}`
        );
        getOutputChannel().appendLine(
            `[Nikas] Responses API: model=${modelId}, inputItems=${Array.isArray(input) ? input.length : 0}, ` +
            `thinking=${thinkingEnabled}, tools=${options.tools?.length ?? 0}, build=v${this.buildVersion}`
        );

        const abortController = new AbortController();
        // v0.7.86 TTFT: time of the first emitted text/tool chunk.
        let firstChunkAt: number | undefined;
        const cancelDisposable = token.onCancellationRequested(() => {
            // Log whether the stop came from VS Code/Copilot (agent loop) vs a
            // user Stop. A silent mid-turn stop is otherwise indistinguishable
            // from a hung stream — both log nothing today.
            log.info(
                `Responses request cancellation requested by VS Code/user (Copilot) — aborting stream. ` +
                `model=${modelId}, thinking=${thinkingEnabled}`
            );
            abortController.abort();
        });

        try {
            const streamResult = await streamDeepSeekResponses(
                request,
                apiKey,
                abortController.signal,
                // onText
                (text: string) => {
                    firstChunkAt ??= Date.now();
                    progress.report(new vscode.LanguageModelTextPart(text));
                },
                // onToolCalls
                (toolCalls) => {
                    firstChunkAt ??= Date.now();
                    // Passive observation: log which native tools DeepSeek actually
                    // requested so we can measure whether the knowledge enrichment
                    // steers it toward Copilot's tools. Read-only — never intercepts
                    // or changes the tool set, so Copilot's native loop is untouched.
                    if (toolCalls && toolCalls.length > 0) {
                        log.info(`[tool-req] DeepSeek requested: ${toolCalls.map(tc => tc.name).join(', ')}`);
                    }
                    for (const tc of toolCalls) {
                        progress.report(
                            new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.arguments)
                        );
                    }
                },
                // onComplete
                (usage) => {
                    if (usage) {
                        progress.report(
                            new vscode.LanguageModelDataPart(
                                new TextEncoder().encode(
                                    JSON.stringify({
                                        prompt_tokens: usage.promptTokens,
                                        completion_tokens: usage.completionTokens,
                                        total_tokens: usage.promptTokens + usage.completionTokens,
                                    })
                                ),
                                'usage'
                            )
                        );
                        // Monitor actual usage vs the configured window
                        logUsageVsWindow(usage.promptTokens, usage.completionTokens, estimatedSentTokens, sessionKey);
                        // Account for usage/cost (additive observer — never blocks).
                        usageTracker.record({
                            provider: 'deepseek-responses',
                            model: modelId,
                            promptTokens: usage.promptTokens,
                            completionTokens: usage.completionTokens,
                            timestamp: Date.now(),
                            latencyMs: Date.now() - startedAt,
                            ttftMs: firstChunkAt ? firstChunkAt - startedAt : undefined,
                            cacheHitTokens: usage.cacheHitTokens,
                            cacheMissTokens: usage.cacheMissTokens,
                            reasoningTokens: usage.reasoningTokens,
                            requestKind: kindId,
                            initiator: getRequestInitiator(options),
                            sessionKey,
                            sessionLabel,
                        });
                    }
                    // NOTE: the vision replay marker is NOT emitted here — it is
                    // emitted ONCE below (combined with any thinking reasoning)
                    // so a turn with both vision + thinking never produces two
                    // stateful_marker data parts (the "doubled image" render bug,
                    // fixed in v0.7.92).
                }
            );

            if (!streamResult.receivedContent && !streamResult.receivedToolCalls) {
                log.info(
                    `Empty response from DeepSeek Responses (finish_reason: ${streamResult.finishReason ?? 'none'}, ` +
                    `max_output_tokens: ${boostedTokens.toLocaleString()}, thinking: ${thinkingEnabled})`
                );
            }

            // Round-trip thinking-mode CoT (see chat handler for rationale).
            // With tools + thinking, DeepSeek REQUIRES reasoning_text to be
            // passed back, or it returns HTTP 400.
            if (streamResult.reasoningText) {
                // Show the CoT natively in the chat UI (collapsed thinking
                // block, like Copilot's own models) where the API supports it.
                reportThinkingPart(progress, streamResult.reasoningText);
                log.verbose(
                    `Captured Responses thinking reasoning (${streamResult.reasoningText.length} chars) for round-trip`
                );
            }

            // Inject a SINGLE replay marker when this turn described images
            // and/or captured thinking reasoning (see chat handler for the
            // doubled-attachment rationale).
            if (replayMarkerMetadata.visionText || streamResult.reasoningText) {
                progress.report(createReplayMarkerPart({
                    ...replayMarkerMetadata,
                    reasoningText: streamResult.reasoningText,
                }));
            }
        } catch (err) {
            if (abortController.signal.aborted) {
                log.info(
                    `Responses request aborted mid-stream — turn did not complete. ` +
                    `model=${modelId}, thinking=${thinkingEnabled}`
                );
                return; // Cancelled by user / VS Code — silent stop
            }
            const errorMessage = err instanceof Error ? err.message : String(err || 'unknown error');
            const wrappedError = new Error(
                `Nikas provider error (model: ${modelId}): ${errorMessage}`
            );
            if (err instanceof Error && err.stack) {
                wrappedError.stack = err.stack;
            }
            log.error(
                `Chat request failed for model "${modelId}" (Responses API, inputItems: ${Array.isArray(input) ? input.length : 0}, tools: ${options.tools?.length ?? 0})`,
                err
            );
            progress.report(new vscode.LanguageModelTextPart(`\n\n❌ ${errorMessage}\n\n`));
            throw wrappedError;
        } finally {
            dedup.settle();
            cancelDisposable.dispose();
        }
        log.info(
            `Responses chat request completed: model=${modelId}, inputItems=${Array.isArray(input) ? input.length : 0}, thinking=${thinkingEnabled}`
        );
    }

    /**
     * Handle a chat request routed to the Gemini API.
     */
    private async handleGeminiChat(
        modelId: string,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const apiKey = await this.secrets.getGeminiApiKey();
        if (!apiKey) {
            throw new Error('Gemini API key not configured. Run "Nikas: Input Gemini API Key" from the command palette.');
        }

        if (token.isCancellationRequested) return;
        const startedAt = Date.now();

        // Convert VS Code messages to Gemini format
        const contents: { role?: string; parts: { text: string }[] }[] = [];
        for (const msg of messages) {
            const role = msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'model' : 'user';
            let text = '';
            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    text += part.value;
                }
            }
            if (text.trim()) {
                contents.push({ role, parts: [{ text: text.trim() }] });
            }
        }

        // Estimate prompt tokens for the usage dashboard (the Gemini
        // generateContent endpoint does not return usage).
        const promptText = contents.map(c => (c.parts ?? []).map(p => p.text ?? '').join('\n')).join('\n');
        const estimatedPrompt = estimateTextTokens(promptText);

        const request = { contents, generationConfig: { temperature: 0.7, maxOutputTokens: 4096 } };
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const abortController = new AbortController();
        const cancelDisposable = token.onCancellationRequested(() => abortController.abort());

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);
            }

            const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message: string } };
            if (data.error) throw new Error(`Gemini API error: ${data.error.message}`);

            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
                progress.report(new vscode.LanguageModelTextPart(text));
                getOutputChannel().appendLine(`[Nikas] Gemini response: ${text.slice(0, 100)}...`);
                // Account for usage/cost (estimated — no usage returned by API).
                usageTracker.record({
                    provider: 'gemini',
                    model: modelId,
                    promptTokens: estimatedPrompt,
                    completionTokens: estimateTextTokens(text),
                    timestamp: Date.now(),
                    latencyMs: Date.now() - startedAt,
                });
            }
        } catch (err) {
            if (abortController.signal.aborted) return;
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.error(`Gemini chat failed for model "${modelId}"`, err);
            progress.report(new vscode.LanguageModelTextPart(`\n\n❌ ${errorMessage}\n\n`));
            throw err;
        } finally {
            cancelDisposable.dispose();
        }
    }

    /**
     * Handle a chat request routed to Gemma 4 via Ollama.
     */
    private async handleGemma4Chat(
        modelId: string,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        if (token.isCancellationRequested) return;
        const startedAt = Date.now();

        // Convert VS Code messages to Ollama format
        const ollamaMessages: { role: string; content: string }[] = [];
        for (const msg of messages) {
            const role = msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
            let content = '';
            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    content += part.value;
                }
            }
            if (content.trim()) {
                ollamaMessages.push({ role, content: content.trim() });
            }
        }

        // Estimate prompt tokens for the usage dashboard (Ollama returns none).
        const promptText = ollamaMessages.map(m => m.content).join('\n');
        const estimatedPrompt = estimateTextTokens(promptText);

        const request = {
            model: modelId,
            messages: ollamaMessages,
            stream: false,
            options: { temperature: 0.7, num_predict: 4096 },
        };

        const { getOllamaBaseUrl } = await import('./config.js');
        const url = `${getOllamaBaseUrl().replace(/\/$/, '')}/api/chat`;

        const abortController = new AbortController();
        const cancelDisposable = token.onCancellationRequested(() => abortController.abort());

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
            }

            const data = await response.json() as { message?: { content?: string; thinking?: string }; error?: string };
            if (data.error) throw new Error(`Ollama error: ${data.error}`);

            const text = data.message?.content?.trim() || data.message?.thinking?.trim();
            if (text) {
                progress.report(new vscode.LanguageModelTextPart(text));
                getOutputChannel().appendLine(`[Nikas] Gemma4 response: ${text.slice(0, 100)}...`);
                // Account for usage (local model — cost is $0, tokens still counted).
                usageTracker.record({
                    provider: 'gemma4',
                    model: modelId,
                    promptTokens: estimatedPrompt,
                    completionTokens: estimateTextTokens(text),
                    timestamp: Date.now(),
                    latencyMs: Date.now() - startedAt,
                });
            }
        } catch (err) {
            if (abortController.signal.aborted) return;
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.error(`Gemma4 chat failed for model "${modelId}"`, err);
            progress.report(new vscode.LanguageModelTextPart(`\n\n❌ ${errorMessage}\n\n`));
            throw err;
        } finally {
            cancelDisposable.dispose();
        }
    }

    /**
     * Create a vision describer based on the current configuration.
     *
     * For Nikas-native vision models (Gemini, Gemma4), we call the API directly
     * — this is the Vizards "api-endpoint" pattern.
     *
     * For Copilot-provided models (GPT-4o, Claude, etc.), we use selectChatModels
     * and wrap the result — this is the Vizards "vscode-lm" pattern.
     *
     * Priority:
     * 1. visionModelKey setting (for Copilot models, vendor/id composite key)
     * 2. visionModel setting (legacy: 'gemini', 'gemini-flash-lite', 'ollama-gemma4')
     * 3. Default: Gemini 2.5 Flash
     */
    private async createVisionDescriber(): Promise<import('./vision/types.js').VisionDescriber | undefined> {
        const config = getConfig();
        const visionModelKey = getVisionModelKey();
        const oldVisionModel = config.get<string>('visionModel');
        const visionSource = getVisionSource();

        visionLog.info(
            `Creating vision describer: visionModelKey=${visionModelKey ?? '(none)'}, ` +
            `visionModel=${oldVisionModel ?? '(none)'}, visionSource=${visionSource}`
        );

        // ── Direct API path ───────────────────────────────────────────
        // Nikas-native models (keys starting with "nikas/") MUST use the direct API
        // because the Copilot LM path would route back to our own provider, which
        // only extracts text parts and drops image data — making vision unusable.
        //
        // The legacy "nika/" and "nika-" prefixes (from the original Nika
        // extension) are also handled here so stored settings keep working.

        // Nikas-native models by visionModelKey ("nikas/gemini-2.5-flash-lite" etc.)
        if (visionModelKey === 'nikas/gemini-2.5-flash-lite' || visionModelKey === 'nika/gemini-2.5-flash-lite') {
            return this.createDirectGeminiDescriber('gemini-2.5-flash-lite');
        }
        if (visionModelKey === 'nikas/gemini-2.5-flash' || visionModelKey === 'nika/gemini-2.5-flash') {
            return this.createDirectGeminiDescriber('gemini-2.5-flash');
        }
        if (visionModelKey === 'nikas/gemma4:31b' || visionModelKey === 'nika/gemma4:31b') {
            return this.createDirectGemma4Describer();
        }

        // Legacy nika-/nikas- prefixed keys
        if (visionModelKey?.startsWith('nikas-') || visionModelKey?.startsWith('nika-')) {
            return this.createNikasDirectDescriber(visionModelKey);
        }

        // Legacy visionModel setting (from "Nikas Native" picker)
        if (!visionModelKey) {
            if (oldVisionModel === 'gemini-flash-lite') {
                return this.createDirectGeminiDescriber('gemini-2.5-flash-lite');
            }
            if (oldVisionModel === 'gemini' || !oldVisionModel) {
                return this.createDirectGeminiDescriber('gemini-2.5-flash');
            }
            if (oldVisionModel === 'ollama-gemma4') {
                return this.createDirectGemma4Describer();
            }
        }

        // ── Copilot LM path (third-party models only) ─────────────────
        // For non-Nikas visionModelKey (e.g. "copilot/gpt-4o", "github/gpt-4o"),
        // try the Copilot LM path. These models are provided by VS Code itself
        // and properly handle image data parts through sendRequest.

        // Special "copilot/auto" (or "auto") key — auto-select the best Copilot
        // vision model, preferring Gemini Flash (uses Copilot quota, no key).
        if (visionModelKey === 'copilot/auto' || visionModelKey === 'auto') {
            visionLog.info('Auto-selecting Copilot vision model (prefers Gemini Flash)');
            const autoModel = await findAutoVisionModel();
            if (autoModel) {
                visionLog.info(`Auto vision model: ${autoModel.id} (${autoModel.vendor})`);
                return new VSCodeLanguageModelVisionDescriber(autoModel);
            }
            visionLog.warn('Auto vision: no Copilot model available — falling back');
        } else if (visionModelKey) {
            visionLog.info(`Trying Copilot LM for model: ${visionModelKey}`);
            const describer = await resolveVisionDescriber({
                source: 'vscode-lm',
                visionModelKey,
            });
            if (describer) return describer;
            visionLog.warn(`Copilot LM model not found: "${visionModelKey}"`);
        }

        // ── Default fallback ─────────────────────────────────────────
        visionLog.info('Falling back to default: Gemini Flash (direct API)');
        return this.createDirectGeminiDescriber('gemini-2.5-flash');
    }

    /**
     * Create a direct Gemini describer that calls the Gemini API directly.
     * This is the Vizards "api-endpoint" pattern for Nikas's built-in models.
     */
    private async createDirectGeminiDescriber(
        modelName: string,
    ): Promise<import('./vision/types.js').VisionDescriber | undefined> {
        const apiKey = await this.secrets.getGeminiApiKey();
        if (!apiKey) {
            visionLog.warn('Gemini API key not configured');
            return undefined;
        }

        const { describeImage } = await import('./vision/gemini.js');

        return {
            id: `gemini:${modelName}`,
            source: 'api-endpoint' as const,
            describe: async (request) => {
                const results: string[] = [];
                for (const [index, image] of request.images.entries()) {
                    const result = await describeImage(
                        image.data,
                        image.mimeType,
                        apiKey,
                        modelName,
                        index === 0 ? request.prompt : undefined,
                    );
                    if (!result.success) {
                        throw new Error(`Gemini vision failed: ${result.error}`);
                    }
                    results.push(result.description);
                }
                return results.join('\n\n---\n\n');
            },
        };
    }

    /**
     * Create a direct Gemma4 describer that calls Ollama directly.
     */
    private async createDirectGemma4Describer(): Promise<import('./vision/types.js').VisionDescriber | undefined> {
        const { getOllamaBaseUrl } = await import('./config.js');
        const { describeImage } = await import('./vision/gemma4.js');

        return {
            id: 'gemma4:31b',
            source: 'api-endpoint' as const,
            describe: async (request) => {
                const results: string[] = [];
                for (const [index, image] of request.images.entries()) {
                    const result = await describeImage(
                        image.data,
                        image.mimeType,
                        getOllamaBaseUrl(),
                        index === 0 ? request.prompt : undefined,
                    );
                    if (!result.success) {
                        throw new Error(`Gemma4 vision failed: ${result.error}`);
                    }
                    results.push(result.description);
                }
                return results.join('\n\n---\n\n');
            },
        };
    }

    /**
     * Map a Nikas provider key to a direct describer.
     */
    private async createNikasDirectDescriber(
        key: string,
    ): Promise<import('./vision/types.js').VisionDescriber | undefined> {
        if (key.includes('gemini-2.5-flash-lite')) {
            return this.createDirectGeminiDescriber('gemini-2.5-flash-lite');
        }
        if (key.includes('gemini')) {
            return this.createDirectGeminiDescriber('gemini-2.5-flash');
        }
        if (key.includes('gemma4')) {
            return this.createDirectGemma4Describer();
        }
        return this.createDirectGeminiDescriber('gemini-2.5-flash');
    }

    /**
     * Rough token count estimation for the Copilot UI meter.
     * Uses the same content-aware estimator as the truncation path
     * (estimateTextTokens + adaptive calibration) so the meter agrees with
     * when truncation actually fires.
     */
    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return applyCalibration(estimateTextTokens(text));
        }

        const content = typeof text.content === 'string'
            ? text.content
            : text.content
                .map(part => {
                    if (part instanceof vscode.LanguageModelTextPart) return part.value;
                    if (part instanceof vscode.LanguageModelDataPart) return `[image:${part.mimeType}]`;
                    // Agent-loop turns carry tool calls + prompt-tsx results;
                    // count their serialized size so the UI meter stays honest.
                    if (part instanceof vscode.LanguageModelToolCallPart) {
                        return safeStringify(part.input);
                    }
                    if (part instanceof vscode.LanguageModelPromptTsxPart) {
                        try {
                            return JSON.stringify(part.value);
                        } catch {
                            return '[PromptTsxPart]';
                        }
                    }
                    return '';
                })
                .join('');

        return applyCalibration(estimateTextTokens(content));
    }
}

/**
 * Validate DeepSeek message sequence ordering.
 * The API expects strict alternating roles (system → user → assistant → user → assistant → ...)
 * with tool results following tool call messages.
 * Returns an array of human-readable issue descriptions (empty if no issues).
 */
function validateMessageSequence(messages: DeepSeekMessage[]): string[] {
    const issues: string[] = [];

    if (messages.length === 0) {
        issues.push('No messages in request');
        return issues;
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const prev = i > 0 ? messages[i - 1] : null;

        // Check 1: System message must be first if present
        if (msg.role === 'system' && i !== 0) {
            issues.push(`Message [${i}]: system role must be first, not at index ${i}`);
        }

        // Check 2: Two consecutive user messages
        if (msg.role === 'user' && prev?.role === 'user') {
            issues.push(`Message [${i}]: two consecutive user messages ([${i - 1}] and [${i}])`);
        }

        // Check 3: Two consecutive assistant messages (without tool calls)
        if (msg.role === 'assistant' && prev?.role === 'assistant' && !msg.tool_calls && !prev?.tool_calls) {
            issues.push(`Message [${i}]: two consecutive assistant messages without tool calls`);
        }

        // Check 4: Tool message without a matching assistant tool_calls message.
        // Scans BACK through the whole window for a caller with the same
        // call_id (not just the immediately preceding message) — an assistant
        // turn with N tool_calls legitimately produces N consecutive tool
        // results, and only the first has the assistant directly before it.
        if (msg.role === 'tool') {
            if (!msg.tool_call_id) {
                issues.push(`Message [${i}]: tool result missing tool_call_id`);
            } else {
                const hasCaller = messages.slice(0, i).some(m =>
                    m.role === 'assistant' &&
                    m.tool_calls?.some(tc => tc.id === msg.tool_call_id)
                );
                if (!hasCaller) {
                    issues.push(`Message [${i}]: tool result without preceding assistant tool_calls message (call_id: ${msg.tool_call_id})`);
                }
            }
        }

        // Check 5: Assistant with tool_calls — content may be null OR a short
        // narration string (Copilot emits both and DeepSeek accepts both; a
        // strict "must be null" check flagged every real agent request). Only
        // a structured content ARRAY alongside tool_calls is genuinely unusual.
        if (msg.tool_calls && msg.tool_calls.length > 0 && Array.isArray(msg.content) && msg.content.length > 0) {
            issues.push(`Message [${i}]: assistant tool_calls message has structured content parts (${msg.content.length})`);
        }

        // Check 6: Check for empty content in user/assistant messages
        if ((msg.role === 'user' || msg.role === 'assistant') && !msg.tool_calls) {
            if (msg.content === null || (typeof msg.content === 'string' && msg.content.trim() === '')) {
                issues.push(`Message [${i}]: ${msg.role} message has empty content`);
            }
        }

        // Check 7: Check for oversized individual messages (>100K chars)
        if (typeof msg.content === 'string' && msg.content.length > 100_000) {
            issues.push(`Message [${i}]: ${msg.role} message content is ${msg.content.length.toLocaleString()} chars (very large)`);
        }
    }

    return issues;
}

/**
 * Resolve the DeepSeek `tool_choice` from the VS Code request's tool mode.
 *
 * VS Code's stable `ProvideLanguageModelChatResponseOptions.toolMode`
 * (`LanguageModelChatToolMode`) tells the provider how tool use must be
 * handled: Auto (1) = the model may call a tool or answer directly (DeepSeek
 * `tool_choice: 'auto'`); Required (2) = the model MUST call one of the
 * provided tools (DeepSeek `tool_choice: 'required'`). The official
 * vscode.d.ts says "The provider must implement respecting this" — Copilot's
 * agent loop and chat participants with `#tool:` references rely on it.
 */
function resolveToolChoice(toolMode: vscode.LanguageModelChatToolMode | undefined): 'auto' | 'required' {
    return toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}

/**
 * Map a VS Code LanguageModelChatTool to DeepSeek tool format.
 * DeepSeek requires every tool parameter schema to be a valid JSON Schema
 * with `type: "object"`. VS Code tools may have null or bare schemas,
 * so we sanitize here.
 */
const FALLBACK_SCHEMA = { type: 'object' as const, properties: {} };

/**
 * Log a one-line summary of how copilot-knowledge treated a native tool.
 * Called from both map functions so the enrichment is visible in the log at
 * INFO level (not just VERBOSE). Non-matching tools log once at VERBOSE only
 * to avoid noise; matching (enriched) tools log their category at INFO.
 */
function logKnowledgeForTool(name: string): void {
    if (!getCopilotKnowledge()) return;
    const k = getToolKnowledge(name);
    if (k) {
        log.info(`[knowledge] tool '${name}' enriched (category: ${k.category})`);
    } else {
        log.verbose(`[knowledge] tool '${name}' not in catalog — passed through unchanged`);
    }
}

/**
 * Log a per-request summary of the copilot-knowledge pass: how many of the
 * native tools were enriched vs passed through, and the categories covered.
 */
function logKnowledgeSummary(tools: readonly vscode.LanguageModelChatTool[]): void {
    if (!getCopilotKnowledge()) {
        log.verbose('Copilot knowledge: disabled (nikas.copilotKnowledge=false)');
        return;
    }
    let enriched = 0;
    const cats = new Set<string>();
    for (const t of tools) {
        const k = getToolKnowledge(t.name);
        if (k) {
            enriched++;
            cats.add(k.category);
        }
    }
    const catList = [...cats].sort().join(', ');
    log.info(`Copilot knowledge: enriched ${enriched}/${tools.length} tools${catList ? ` [${catList}]` : ''}`);
    if (enriched === 0) {
        log.info('Copilot knowledge: ON but no tools matched the catalog — all passed through unchanged');
    }
}

function mapTool(tool: vscode.LanguageModelChatTool): DeepSeekTool {
    const rawSchema = tool.inputSchema as Record<string, unknown> | null | undefined;
    const parameters = sanitizeSchema(rawSchema);
    // Optionally enrich the description with Copilot knowledge so DeepSeek
    // understands what the native tool does and when to use it.
    logKnowledgeForTool(tool.name);
    const description = getCopilotKnowledge()
        ? augmentToolDescription(tool.name, tool.description ?? '')
        : tool.description ?? '';

    return {
        type: 'function',
        function: {
            name: tool.name,
            description,
            parameters,
        },
    };
}

function sanitizeSchema(schema: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return FALLBACK_SCHEMA;
    }
    // Recursively clean the schema: ensure every object schema has a valid
    // `type`, and strip any `type: null` (which DeepSeek rejects with a 400 —
    // e.g. the `container-tools_get-config` tool ships a null schema).
    const cleaned = cleanSchemaNode(schema);
    if (!cleaned.type || cleaned.type !== 'object') {
        return { ...cleaned, type: 'object' };
    }
    return cleaned;
}

/**
 * Recursively normalize a JSON Schema so that no `type` is `null` and every
 * object/array schema carries a valid `type`. Returns a NEW object (does not
 * mutate the input). Unknown/primitive leaves are left as-is.
 */
function cleanSchemaNode(node: unknown): Record<string, unknown> {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return { ...FALLBACK_SCHEMA, ...(typeof node === 'object' && node ? { ...node as Record<string, unknown> } : {}) };
    }
    const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };

    // A `type: null` is invalid — drop it so the node inherits a valid type.
    if (Object.prototype.hasOwnProperty.call(out, 'type') && (out.type === null || out.type === undefined)) {
        delete out.type;
    }

    // Recurse into nested schema containers.
    if (out.properties && typeof out.properties === 'object') {
        const props: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(out.properties as Record<string, unknown>)) {
            props[k] = cleanSchemaNode(v as Record<string, unknown>);
        }
        out.properties = props;
    }
    if (out.items && typeof out.items === 'object') {
        out.items = cleanSchemaNode(out.items as Record<string, unknown>);
    }
    if (Array.isArray(out.anyOf)) {
        out.anyOf = out.anyOf.map((v) => cleanSchemaNode(v as Record<string, unknown>));
    }
    if (Array.isArray(out.allOf)) {
        out.allOf = out.allOf.map((v) => cleanSchemaNode(v as Record<string, unknown>));
    }
    if (Array.isArray(out.oneOf)) {
        out.oneOf = out.oneOf.map((v) => cleanSchemaNode(v as Record<string, unknown>));
    }

    return out;
}

/**
 * Map a VS Code LanguageModelChatTool to the Responses API tool format.
 *
 * The Responses API FLATTENS the function definition — `name`, `description`,
 * and `parameters` are top-level tool fields (NOT nested under `function` like
 * Chat Completions). Sending the Chat Completions shape fails deserialization
 * with `tools[0]: missing field name`.
 */
function mapResponsesTool(tool: vscode.LanguageModelChatTool): DeepSeekResponsesTool {
    const rawSchema = tool.inputSchema as Record<string, unknown> | null | undefined;
    const parameters = sanitizeSchema(rawSchema);
    logKnowledgeForTool(tool.name);
    const description = getCopilotKnowledge()
        ? augmentToolDescription(tool.name, tool.description ?? '')
        : tool.description ?? '';
    const raw: DeepSeekResponsesTool = {
        type: 'function',
        name: tool.name,
        description,
        parameters,
    };
    return raw;
}

/**
 * Schema for the per-model "Thinking Effort" dropdown in Copilot Chat's model
 * picker. Matches upstream Nika exactly (values `none`/`low`/`high`/`max`),
 * plus (C-8, v0.7.88) a per-model temperature slider.
 *
 * The dropdown's selected values are delivered to the request via
 * `options.modelConfiguration.{reasoningEffort,temperature}`, which
 * `getRequestThinkingEffort` / `getRequestTemperature` read first (falling
 * back to the saved `nikas.thinkingEffort` / `nikas.temperature` settings).
 */
function buildThinkingEffortSchema() {
    return {
        properties: {
            reasoningEffort: {
                type: 'string',
                title: 'Thinking Effort',
                enum: ['none', 'low', 'high', 'max'],
                enumItemLabels: ['None', 'Low', 'High', 'Max'],
                enumDescriptions: [
                    'Disable thinking for faster responses',
                    'Light reasoning — fastest thinking mode, good for simple lookups',
                    'Recommended for most tasks — balanced reasoning',
                    'Maximum reasoning depth for complex agent tasks',
                ],
                default: 'high',
                group: 'navigation',
            },
            temperature: {
                type: 'number',
                title: 'Temperature',
                minimum: 0,
                maximum: 2,
                default: getTemperature(),
                description: 'Sampling temperature for this model (0 = deterministic). Per-model override of nikas.temperature.',
            },
        },
    };
}

/**
 * A-4 (v0.7.88): advertise the edit tools DeepSeek prefers so Copilot Chat
 * matches the model's strengths. See LanguageModelChatCapabilities.editTools.
 * Cast through a loose type because the `editTools` field is a proposed API
 * that may not be in the compiled vscode.d.ts.
 *
 * REQUIRES the `chatProvider` API proposal in package.json#enabledApiProposals:
 * the extension host throws `CANNOT use API proposal: chatProvider` for any
 * model whose capabilities contain `editTools` unless the extension declares
 * the proposal — which aborts the ENTIRE provider model list (empty picker).
 * See v0.7.91 for the fix that added `"chatProvider"` to enabledApiProposals.
 */
function withEditTools(capabilities: unknown): unknown {
    return {
        ...(capabilities as Record<string, unknown>),
        editTools: ['find-replace', 'multi-find-replace'],
    };
}

/**
 * F-17 (v0.7.88): read the proposed `requestInitiator` from the response
 * options through a loose cast (it may not be present in every VS Code build).
 * Returns `undefined` when unavailable — callers must treat it as optional.
 */
function getRequestInitiator(options: unknown): string | undefined {
    try {
        const v = (options as Record<string, unknown>)['requestInitiator'];
        return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    } catch {
        return undefined;
    }
}

/**
 * C-8 (v0.7.88): read the per-model temperature from the model-picker dropdown
 * (`options.modelConfiguration.temperature`) or fall back to the saved
 * `nikas.temperature` setting.
 */
function getRequestTemperature(options: unknown): number {
    const extOptions = (options ?? {}) as Record<string, unknown>;
    const modelConfig = (extOptions.modelConfiguration ?? {}) as Record<string, unknown>;
    const cfg = (extOptions.configuration ?? {}) as Record<string, unknown>;
    const configured = (modelConfig.temperature ?? cfg.temperature) as number | undefined;
    if (typeof configured === 'number' && Number.isFinite(configured)) {
        return Math.min(2, Math.max(0, configured));
    }
    return getTemperature();
}

/**
 * Read the thinking effort from the request options (set by Copilot Chat's
 * model-picker "Thinking Effort" dropdown) or fall back to the saved
 * `nikas.thinkingEffort` setting. Mirrors upstream Nika's
 * `getRequestThinkingEffort`.
 */
function getRequestThinkingEffort(options: unknown): ThinkingEffort {
    const extOptions = (options ?? {}) as Record<string, unknown>;
    const modelConfig = (extOptions.modelConfiguration ?? {}) as Record<string, unknown>;
    const cfg = (extOptions.configuration ?? {}) as Record<string, unknown>;
    const configuredEffort = (modelConfig.reasoningEffort ?? cfg.reasoningEffort) as string | undefined;
    if (configuredEffort === 'none') return 'off';
    if (configuredEffort === 'low') return 'low';
    if (configuredEffort === 'high') return 'high';
    if (configuredEffort === 'max') return 'max';
    // Fall back to the saved setting (for users who haven't used the dropdown yet)
    return getThinkingEffort();
}

/**
 * Build DeepSeek chat-completions thinking parameters from effort level.
 *
 * DeepSeek's API uses:
 *   thinking.type: "enabled" | "disabled"
 *   reasoning_effort: "low" | "high" | "max"
 *
 * Per the API docs' effort mapping, for `deepseek-v4-flash`:
 *   low → low (genuinely lighter reasoning)
 *   high → high
 *   xhigh → high
 *   max → max
 * (Pro collapses low → high; we pass the user's request through either way.)
 *
 * Effort levels:
 *   off  → thinking disabled
 *   low  → thinking enabled, light reasoning
 *   high → thinking enabled, standard reasoning (default)
 *   max  → thinking enabled, maximum reasoning (for complex agent tasks)
 */
function buildThinkingParams(effort: ThinkingEffort): Partial<DeepSeekRequest> {
    if (effort === 'off') {
        return {
            thinking: { type: 'disabled' },
        };
    }

    return {
        thinking: { type: 'enabled' },
        reasoning_effort: effort,
    };
}

/**
 * Build Responses API reasoning parameters from effort level.
 *
 * The Responses API uses a top-level `reasoning: { effort }` field instead of
 * chat-completions' `thinking`/`reasoning_effort` pair. Per DeepSeek's
 * Thinking Mode guide, valid efforts are `none`/`low`/`high`/`max`, where
 * `none` DISABLES thinking mode (thinking is enabled by default when the
 * parameter is absent, so omitting `reasoning` would NOT turn it off).
 */
function buildResponsesThinkingParams(effort: ThinkingEffort): { reasoning?: { effort: 'none' | 'low' | 'high' | 'max' } } {
    if (effort === 'off') {
        return {
            reasoning: { effort: 'none' },
        };
    }

    return {
        reasoning: { effort },
    };
}
