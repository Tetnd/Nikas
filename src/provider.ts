import * as vscode from 'vscode';
import { SecretStore } from './secrets.js';
import { DEEPSEEK_MODELS, DEEPSEEK_RESPONSES_MODEL, getConfig, getSelectedModel, getMaxTokens, getTemperature, ThinkingEffort, getThinkingEffort, getContextWindowTokens, getContextWindowPreset, getVisionModelKey, getVisionSource, VisionSource, getConcisePrompt, CONCISE_PROMPT_DIRECTIVE, getStabilizeToolListEnabled } from './config.js';
import { vscodeMessagesToDeepSeek, deepseekMessagesToResponsesInput } from './transform/messages.js';
import { streamDeepSeekChat, streamDeepSeekResponses } from './api/deepseek.js';
import { safeStringify } from './api/sanitize.js';
import { resolveImageMessages, resolveSparsePdfVision, resolveVisionDescriber } from './vision/pipeline.js';
import { VSCodeLanguageModelVisionDescriber, findAutoVisionModel } from './vision/sources/vscode-lm.js';
import { createReplayMarkerPart, hasImageParts } from './vision/replay.js';
import { classifyProviderRequest, shouldForceThinkingNone } from './routing.js';
import { processToolFlow } from './tools/flow.js';
import { assertToolsWithinLimit } from './tools/request.js';
import { log } from './log.js';
import { visionLog } from './vision/log.js';
import type { DeepSeekRequest, DeepSeekTool, DeepSeekMessage, DeepSeekResponsesRequest, DeepSeekResponsesTool } from './api/types.js';
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
 * Rough token count estimation for messages.
 * DeepSeek uses a BPE tokenizer; we approximate at ~4 chars/token.
 *
 * CALIBRATED 2026-08-09: measured against the API's real usage.input_tokens,
 * the raw ~4 chars/token estimate consistently UNDERCOUNTS by ~40%
 * (real/est ratio ≈ 1.40, stable from ~100K to ~1M real tokens). Without the
 * multiplier, a 1M contextWindow corresponds to ~1.39M real tokens — past the
 * model's 1,048,576 hard ceiling — so the extension's own truncation would
 * fire only AFTER the API starts rejecting requests with HTTP 400.
 */
const ESTIMATE_CALIBRATION = 1.4;

function estimateMessageTokens(messages: DeepSeekMessage[]): number {
    let total = 0;
    for (const msg of messages) {
        // Base overhead per message (~4 tokens for role formatting)
        total += 4;
        if (typeof msg.content === 'string') {
            total += Math.ceil(msg.content.length / 4);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text) {
                    total += Math.ceil(part.text.length / 4);
                }
            }
        }
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                total += Math.ceil(tc.function.name.length / 4);
                total += Math.ceil(tc.function.arguments.length / 4);
            }
        }
        // Thinking-mode CoT round-tripped on assistant messages also consumes
        // context — count it so truncation fires before the API ceiling.
        if (msg.reasoning_content) {
            total += Math.ceil(msg.reasoning_content.length / 4);
        }
    }
    // Calibrate the raw 4-char/token estimate to real token counts
    // (measured real/est ≈ 1.40 on the official API).
    return Math.ceil(total * ESTIMATE_CALIBRATION);
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
 * Log actual API token usage against the configured context window.
 * The local ~4 chars/token estimate can undercount; the API's real
 * prompt_tokens is the ground truth for how close we are to the limit.
 */
function logUsageVsWindow(promptTokens: number, completionTokens: number): void {
    const windowTokens = getContextWindowTokens();
    const fillPct = Math.round((promptTokens / windowTokens) * 100);
    const base =
        `DeepSeek usage: prompt=${promptTokens.toLocaleString()} ` +
        `(${fillPct}% of ${windowTokens.toLocaleString()} window), ` +
        `completion=${completionTokens.toLocaleString()}`;
    if (fillPct >= 85) {
        const msg =
            `${base}\n` +
            `  ⚠ Prompt is ${fillPct}% of the context window. The next truncation will drop ` +
            `the oldest messages — the model loses memory of early facts and may hallucinate ` +
            `about them. Start a new session for fresh context.`;
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
function truncateMessagesToContextWindow(messages: DeepSeekMessage[]): DeepSeekMessage[] {
    const maxContextTokens = getContextWindowTokens();
    const maxOutputTokens = getMaxTokens();
    // Reserve space for output — input context = total - max_output - safety buffer.
    // Clamp to a small floor so the budget can never go negative (which would
    // drop every message and produce an empty request → HTTP 400).
    const availableInputTokens = Math.max(1024, maxContextTokens - maxOutputTokens - 1024);

    const systemMessages: DeepSeekMessage[] = [];
    const otherMessages: DeepSeekMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'system' && systemMessages.length === 0) {
            systemMessages.push(msg);
        } else {
            otherMessages.push(msg);
        }
    }

    const estimatedTokens = estimateMessageTokens(messages);
    const fillPercent = Math.round((estimatedTokens / availableInputTokens) * 100);

    if (estimatedTokens <= availableInputTokens) {
        // Everything fits — but the sequence may still be invalid (e.g. the
        // conversation ends mid-tool-call during auto-compact). Repair it.
        const repaired = repairTruncatedSequence(systemMessages, otherMessages);
        logContextHealth(estimatedTokens, availableInputTokens, fillPercent);
        return repaired;
    }

    // Need to truncate. Keep system message, then keep the most recent messages.
    const keptMessages: DeepSeekMessage[] = [];
    let tokenBudget = availableInputTokens - estimateMessageTokens(systemMessages);

    for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgTokens = estimateMessageTokens([msg]);
        if (msgTokens <= tokenBudget) {
            keptMessages.unshift(msg);
            tokenBudget -= msgTokens;
        } else {
            // This message is too large — skip it and everything older
            break;
        }
    }

    const truncated = repairTruncatedSequence(systemMessages, keptMessages);

    // Identify what the model just "forgot": messages present in the input
    // that are not in the final (truncated + repaired) sequence.
    const keptSet = new Set<DeepSeekMessage>(truncated);
    const dropped = messages.filter(m => !keptSet.has(m));
    logContextHealth(estimatedTokens, availableInputTokens, fillPercent, dropped);

    return truncated;
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
                    capabilities: m.capabilities,
                    detail: m.detail,
                };

                // Both Flash and Pro support thinking — add the per-model dropdown
                // in Copilot Chat's model picker (matching Vizards UX).
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
                capabilities: DEEPSEEK_RESPONSES_MODEL.capabilities,
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

        // Process the tool preflight flow: strip provider-owned preflight
        // artifacts from the history, and (when the experimental stabilize
        // setting is on) pre-activate VS Code/Copilot virtual tools. When
        // preflight calls were emitted, this request is complete — the real
        // DeepSeek request happens once the tool list is stable.
        const toolFlow = processToolFlow({
            stabilizeToolList: getStabilizeToolListEnabled(),
            messages,
            tools: options.tools,
            progress,
        });
        if (toolFlow.preflightHandled) {
            return;
        }

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
        const visionResolution = await resolveImageMessages(toolFlow.messages, token, getDescriber);
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
                `unavailable=${s.unavailableImageMessages} failed=${s.failedImageMessages}`
            );
        }

        // Show any vision notices to the user
        if (visionResolution.initialResponseNotice) {
            progress.report(new vscode.LanguageModelTextPart(
                `\n\n${visionResolution.initialResponseNotice}\n\n`
            ));
        }

        // Show any tool-flow notices (e.g. unstable tool list) to the user
        if (toolFlow.initialResponseNotice) {
            progress.report(new vscode.LanguageModelTextPart(
                `\n\n${toolFlow.initialResponseNotice}\n\n`
            ));
        }

        if (token.isCancellationRequested) return;

        // Convert resolved VS Code messages to DeepSeek format
        let deepseekMessages = await vscodeMessagesToDeepSeek(resolvedMessages);

        // Truncate messages to fit within the configured context window
        deepseekMessages = truncateMessagesToContextWindow(deepseekMessages);

        // Optionally inject the "no process narration" directive into the first
        // system message (chat-completions path). See the Responses handler for
        // the rationale — this stops the model narrating its process as visible
        // reply text in agent mode WITHOUT reducing the tool set.
        if (getConcisePrompt() && deepseekMessages.length > 0) {
            const first = deepseekMessages[0];
            if (first.role === 'system') {
                const base = typeof first.content === 'string'
                    ? first.content
                    : Array.isArray(first.content)
                        ? first.content.map(p => p.type === 'text' ? p.text : '').join('')
                        : '';
                first.content = `${base}\n\n${CONCISE_PROMPT_DIRECTIVE}`;
            }
        }

        if (token.isCancellationRequested) return;

        // Build the API request
        const config = getConfig();
        const modelId = getSelectedModel();

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

        // Read thinking effort from Copilot Chat's model picker dropdown first,
        // fall back to the saved nikas.thinkingEffort setting. Internal helper
        // requests (chat titles, commit messages, settings resolver, ...) only
        // get thinking FORCED OFF when nikas.routing.forceThinkingNone is
        // enabled (default off, matching upstream Nika — see routing.ts).
        const requestKind = classifyProviderRequest({ messages, tools: options.tools });
        const forcedThinkingOff = shouldForceThinkingNone(requestKind);
        const thinkingEffort = forcedThinkingOff ? 'off' : getRequestThinkingEffort(options);
        const thinkingParams = buildThinkingParams(thinkingEffort);

        // Log which effort is being used
        const extOpts = options as unknown as Record<string, unknown>;
        const hasDropdownEffort = !!(extOpts.modelConfiguration as Record<string, unknown> | undefined)?.reasoningEffort;
        getOutputChannel().appendLine(
            `[Nikas] Thinking effort: ${thinkingEffort}${hasDropdownEffort ? ' (from model picker dropdown)' : ''}` +
            (forcedThinkingOff ? ` (internal helper: ${requestKind} — forced off)` : '')
        );
        if (forcedThinkingOff) {
            log.verbose(`Internal helper request (${requestKind}) — thinking forced off`);
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
            temperature: getTemperature(),
            max_tokens: boostedTokens,
            stream: true,
            ...thinkingParams,
            stream_options: { include_usage: true },
        };

        // Add tools if provided in options
        if (options.tools && options.tools.length > 0) {
            request.tools = options.tools.map(mapTool);
            // DeepSeek supports at most 128 functions per request (upstream #77).
            assertToolsWithinLimit(request.tools, 'chat-completions');
            request.tool_choice = 'auto';
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
        const cancelDisposable = token.onCancellationRequested(() => {
            abortController.abort();
        });

        try {
            const streamResult = await streamDeepSeekChat(
                request,
                apiKey,
                abortController.signal,
                // onText
                (text: string) => {
                    progress.report(new vscode.LanguageModelTextPart(text));
                },
                // onToolCalls
                (toolCalls) => {
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
                        logUsageVsWindow(usage.promptTokens, usage.completionTokens);
                    }

                    // Inject replay marker if we described images this turn
                    // This allows the next turn to replay descriptions without
                    // calling the vision model again.
                    if (replayMarkerMetadata.visionText) {
                        progress.report(createReplayMarkerPart(replayMarkerMetadata));
                    }
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
                progress.report(createReplayMarkerPart({
                    ...replayMarkerMetadata,
                    reasoningText: streamResult.reasoningText,
                }));
                log.verbose(
                    `Captured thinking reasoning (${streamResult.reasoningText.length} chars) for round-trip`
                );
            }
        } catch (err) {
            if (abortController.signal.aborted) {
                // Cancelled by user — silently stop
                return;
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
            cancelDisposable.dispose();
        }
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

        // Process the tool preflight flow (see chat handler for rationale).
        const toolFlow = processToolFlow({
            stabilizeToolList: getStabilizeToolListEnabled(),
            messages,
            tools: options.tools,
            progress,
        });
        if (toolFlow.preflightHandled) {
            return;
        }

        // Resolve images to text descriptions (same pipeline as chat completions)
        const getDescriber = async () => {
            try {
                return await this.createVisionDescriber();
            } catch (err) {
                visionLog.error('Failed to create vision describer', err);
                return undefined;
            }
        };
        const visionResolution = await resolveImageMessages(toolFlow.messages, token, getDescriber);
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
                `unavailable=${s.unavailableImageMessages} failed=${s.failedImageMessages}`
            );
        }

        if (visionResolution.initialResponseNotice) {
            progress.report(new vscode.LanguageModelTextPart(
                `\n\n${visionResolution.initialResponseNotice}\n\n`
            ));
        }

        // Show any tool-flow notices (e.g. unstable tool list) to the user
        if (toolFlow.initialResponseNotice) {
            progress.report(new vscode.LanguageModelTextPart(
                `\n\n${toolFlow.initialResponseNotice}\n\n`
            ));
        }

        if (token.isCancellationRequested) return;

        // Convert + truncate to DeepSeek message form, then to Responses input
        let deepseekMessages = await vscodeMessagesToDeepSeek(resolvedMessages);
        deepseekMessages = truncateMessagesToContextWindow(deepseekMessages);
        const { input, instructions } = deepseekMessagesToResponsesInput(deepseekMessages);

        // Optionally inject the "no process narration" directive into the system
        // prompt. In agent mode Flash tends to narrate its process as visible
        // reply text ("Let me check...", "I'll search for..."), which reads as
        // "spamming thinking as replies". This directive stops that WITHOUT
        // reducing the tool set. (Controlled by nikas.concisePrompt.)
        const conciseDirective = getConcisePrompt() ? `\n\n${CONCISE_PROMPT_DIRECTIVE}` : '';

        // Thinking effort from the picker dropdown / nikas.thinkingEffort setting.
        // Internal helper requests only get thinking FORCED OFF when
        // nikas.routing.forceThinkingNone is enabled (default off, matching
        // upstream Nika — see routing.ts).
        const requestKind = classifyProviderRequest({ messages, tools: options.tools });
        const forcedThinkingOff = shouldForceThinkingNone(requestKind);
        const thinkingEffort = forcedThinkingOff ? 'off' : getRequestThinkingEffort(options);
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
        const extOpts = options as unknown as Record<string, unknown>;
        const hasDropdownEffort = !!(extOpts.modelConfiguration as Record<string, unknown> | undefined)?.reasoningEffort;
        getOutputChannel().appendLine(
            `[Nikas] Thinking effort: ${thinkingEffort}${hasDropdownEffort ? ' (from model picker dropdown)' : ''}` +
            (forcedThinkingOff ? ` (internal helper: ${requestKind} — forced off)` : '')
        );
        if (forcedThinkingOff) {
            log.verbose(`Internal helper request (${requestKind}) — thinking forced off`);
        }

        const request: DeepSeekResponsesRequest = {
            // The Responses API only supports deepseek-v4-flash (not Pro).
            model: 'deepseek-v4-flash',
            input,
            temperature: getTemperature(),
            max_output_tokens: boostedTokens,
            stream: true,
            ...reasoningParams,
        };
        if (instructions) request.instructions = instructions + conciseDirective;
        else if (conciseDirective) request.instructions = CONCISE_PROMPT_DIRECTIVE;

        if (options.tools && options.tools.length > 0) {
            request.tools = options.tools.map(mapResponsesTool);
            // DeepSeek supports at most 128 functions per request (upstream #77).
            assertToolsWithinLimit(request.tools, 'responses');
            request.tool_choice = 'auto';
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
        const cancelDisposable = token.onCancellationRequested(() => {
            abortController.abort();
        });

        try {
            const streamResult = await streamDeepSeekResponses(
                request,
                apiKey,
                abortController.signal,
                // onText
                (text: string) => {
                    progress.report(new vscode.LanguageModelTextPart(text));
                },
                // onToolCalls
                (toolCalls) => {
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
                        logUsageVsWindow(usage.promptTokens, usage.completionTokens);
                    }
                    if (replayMarkerMetadata.visionText) {
                        progress.report(createReplayMarkerPart(replayMarkerMetadata));
                    }
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
                progress.report(createReplayMarkerPart({
                    ...replayMarkerMetadata,
                    reasoningText: streamResult.reasoningText,
                }));
                log.verbose(
                    `Captured Responses thinking reasoning (${streamResult.reasoningText.length} chars) for round-trip`
                );
            }
        } catch (err) {
            if (abortController.signal.aborted) {
                return; // Cancelled by user — silently stop
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
            cancelDisposable.dispose();
        }
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
     * Rough token count estimation.
     * DeepSeek uses a BPE tokenizer; we approximate at ~4 chars/token.
     *
     * Calibrated ×1.4 to match real API token counts (see
     * ESTIMATE_CALIBRATION) so the Copilot UI meter stays accurate.
     */
    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil((text.length / 4) * ESTIMATE_CALIBRATION);
        }

        const content = typeof text.content === 'string'
            ? text.content
            : text.content
                .map(part => {
                    if (part instanceof vscode.LanguageModelTextPart) return part.value;
                    if (part instanceof vscode.LanguageModelDataPart) return `[image:${part.mimeType}]`;
                    return '';
                })
                .join('');

        return Math.ceil((content.length / 4) * ESTIMATE_CALIBRATION);
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
        const next = i < messages.length - 1 ? messages[i + 1] : null;

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

        // Check 4: Tool message without a preceding assistant message with tool_calls
        if (msg.role === 'tool') {
            if (!prev || prev.role !== 'assistant' || !prev.tool_calls) {
                issues.push(`Message [${i}]: tool result without preceding assistant tool_calls message`);
            }
            // Check that tool_call_id exists
            if (!msg.tool_call_id) {
                issues.push(`Message [${i}]: tool result missing tool_call_id`);
            }
        }

        // Check 5: Assistant with tool_calls should have content: null (or empty)
        if (msg.tool_calls && msg.tool_calls.length > 0 && msg.content !== null) {
            issues.push(`Message [${i}]: assistant tool_calls message should have content: null, got content type: ${typeof msg.content}`);
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
 * Map a VS Code LanguageModelChatTool to DeepSeek tool format.
 * DeepSeek requires every tool parameter schema to be a valid JSON Schema
 * with `type: "object"`. VS Code tools may have null or bare schemas,
 * so we sanitize here.
 */
const FALLBACK_SCHEMA = { type: 'object' as const, properties: {} };

function mapTool(tool: vscode.LanguageModelChatTool): DeepSeekTool {
    const rawSchema = tool.inputSchema as Record<string, unknown> | null | undefined;
    const parameters = sanitizeSchema(rawSchema);

    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description ?? '',
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

    return {
        type: 'function',
        name: tool.name,
        description: tool.description ?? '',
        parameters,
    };
}

/**
 * Build the `configurationSchema` that makes Copilot Chat render a per-model
 * Thinking Effort dropdown (None / Low / High / Max) next to the model picker.
 *
 * This matches the Vizards approach — the dropdown appears for every model
 * that supports thinking, and the user's choice comes through as
 * `options.modelConfiguration.reasoningEffort` on each request.
 *
 * Levels match DeepSeek's Thinking Mode guide: for `deepseek-v4-flash`, `low`
 * maps to a genuinely lower reasoning effort (distinct from `high`); only Pro
 * collapses `low` → `high` server-side.
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
                    'None — fastest, lowest cost. Best for simple Q&A and quick tasks',
                    'Low — light reasoning, faster than High/Max',
                    'High — balanced reasoning',
                    'Max (default) — best quality for complex builds, but slowest and most expensive (verified in weather-app A/B: much better final product, ~5x slower)',
                ],
                default: 'max',
                group: 'navigation',
            },
        },
    } as const;
}

/**
 * Read the thinking effort from the request options (set by Copilot Chat's
 * model picker dropdown) or fall back to the saved `nikas.thinkingEffort`
 * setting for backward compatibility.
 *
 * Maps 'none' (Copilot dropdown value) → 'off' (Nikas's internal value).
 */
function getRequestThinkingEffort(
    options: vscode.ProvideLanguageModelChatResponseOptions,
): ThinkingEffort {
    const extOptions = options as unknown as Record<string, unknown>;
    const modelConfig = extOptions.modelConfiguration as Record<string, unknown> | undefined;
    const cfg = extOptions.configuration as Record<string, unknown> | undefined;
    const configuredEffort = modelConfig?.reasoningEffort ?? cfg?.reasoningEffort;

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
