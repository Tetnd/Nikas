import * as vscode from 'vscode';
import { SecretStore } from './secrets.js';
import { DEEPSEEK_MODELS, getConfig, getSelectedModel, getMaxTokens, getTemperature, ThinkingEffort, getThinkingEffort, getContextWindowTokens, getContextWindowPreset, getVisionModelKey } from './config.js';
import { vscodeMessagesToDeepSeek } from './transform/messages.js';
import { streamDeepSeekChat } from './api/deepseek.js';
import { safeStringify } from './api/sanitize.js';
import { resolveImageMessages, resolveVisionDescriber } from './vision/pipeline.js';
import { createReplayMarkerPart, hasImageParts } from './vision/replay.js';
import { log } from './log.js';
import { visionLog } from './vision/log.js';
import type { DeepSeekRequest, DeepSeekTool, DeepSeekMessage } from './api/types.js';
import type { ReplayMarkerMetadata } from './vision/types.js';

/**
 * VS Code Output channel for Nika diagnostics.
 * Visible in View → Output → "Nika".
 */
let _outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
    if (!_outputChannel) {
        _outputChannel = vscode.window.createOutputChannel('Nika');
    }
    return _outputChannel;
}

/**
 * Rough token count estimation for messages.
 * DeepSeek uses a BPE tokenizer; we approximate at ~4 chars/token.
 */
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
    }
    return total;
}

/**
 * Truncate messages to fit within the configured context window.
 * Preserves the system message (first message) and removes oldest user/assistant
 * messages from the middle when the context is exceeded.
 */
function truncateMessagesToContextWindow(messages: DeepSeekMessage[]): DeepSeekMessage[] {
    const maxContextTokens = getContextWindowTokens();
    const maxOutputTokens = getMaxTokens();
    // Reserve space for output — input context = total - max_output - safety buffer
    const availableInputTokens = maxContextTokens - maxOutputTokens - 1024;

    const estimatedTokens = estimateMessageTokens(messages);
    if (estimatedTokens <= availableInputTokens) {
        return messages;
    }

    // Need to truncate. Keep system message (index 0 if it's role: 'system'),
    // then keep the most recent messages.
    const systemMessages: DeepSeekMessage[] = [];
    const otherMessages: DeepSeekMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'system' && systemMessages.length === 0) {
            systemMessages.push(msg);
        } else {
            otherMessages.push(msg);
        }
    }

    // Work from newest to oldest, keeping what fits
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

    const truncated = [...systemMessages, ...keptMessages];

    log.info(
        `Context window: truncated from ${messages.length} to ${truncated.length} messages ` +
        `(~${estimateMessageTokens(messages).toLocaleString()} → ~${estimateMessageTokens(truncated).toLocaleString()} tokens)`
    );

    return truncated;
}

/**
 * NikaChatProvider — a VS Code LanguageModelChatProvider bringing multiple
 * model families under the single "Nika" vendor.
 *
 * - DeepSeek V4 Flash & Pro → proxied to DeepSeek API
 * - Gemini 2.5 Flash & Flash-Lite → proxied to Gemini API
 * - Gemma 4 (Ollama) → proxied to local Ollama
 *
 * Registered via vscode.lm.registerLanguageModelChatProvider('nika', provider).
 * All models appear in Copilot Chat's model picker under "Nika".
 */
export class NikaChatProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
    private readonly secrets: SecretStore;

    constructor(context: vscode.ExtensionContext) {
        this.secrets = new SecretStore(context.secrets);
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
     * Shows all configured models under the single "Nika" vendor.
     *
     * - DeepSeek models: require DeepSeek API key
     * - Gemini models: require Gemini API key
     * - Gemma 4: always available (local Ollama, no key needed)
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const models: vscode.LanguageModelChatInformation[] = [];
        const deepseekKey = await this.secrets.getDeepSeekApiKey();
        const geminiKey = await this.secrets.getGeminiApiKey();

        // ── DeepSeek models ──────────────────────────────────────────
        if (deepseekKey) {
            const effectiveInputTokens = getContextWindowTokens();
            const effectiveOutputTokens = getMaxTokens();
            for (const m of DEEPSEEK_MODELS) {
                models.push({
                    id: m.id,
                    name: m.name,
                    family: m.family,
                    version: m.version,
                    maxInputTokens: Math.min(m.maxInputTokens, effectiveInputTokens),
                    maxOutputTokens: Math.min(m.maxOutputTokens, effectiveOutputTokens),
                    capabilities: m.capabilities,
                    detail: m.detail,
                });
            }
        } else if (!options.silent) {
            vscode.window.showWarningMessage(
                'Nika: DeepSeek API key not configured. DeepSeek models will not appear in the model picker until the key is set.'
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
                    capabilities: {},
                    detail: 'Google Gemini 2.5 Flash — free tier',
                },
                {
                    id: 'gemini-2.5-flash-lite',
                    name: 'Gemini 2.5 Flash-Lite',
                    family: 'gemini',
                    version: '2.5.0',
                    maxInputTokens: 1_000_000,
                    maxOutputTokens: 8_192,
                    capabilities: {},
                    detail: 'Google Gemini 2.5 Flash-Lite — fastest, most cost-efficient',
                }
            );
        } else if (!options.silent && !deepseekKey) {
            // Only show one warning if neither key is set
            vscode.window.showWarningMessage(
                'Nika: Gemini API key not configured. Gemini models will not appear in the model picker until the key is set.'
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
            capabilities: {},
            detail: 'Local Gemma 4 via Ollama — runs on your machine',
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

        // ── DeepSeek handler (inline, for minimal diff) ──────────────
        const apiKey = await this.secrets.getDeepSeekApiKey();
        if (!apiKey) {
            throw new Error(
                'DeepSeek API key not configured. Run "Nika: Input Deepseek userToken" from the command palette (F1).'
            );
        }

        // Check for cancellation
        if (token.isCancellationRequested) return;

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
        const resolvedMessages = visionResolution.messages;
        const replayMarkerMetadata = visionResolution.replayMarkerMetadata;

        // Log vision stats for diagnostics
        if (visionResolution.stats.inputImageParts > 0) {
            const s = visionResolution.stats;
            visionLog.info(
                `Vision: ${s.inputImageParts} image(s) in ${s.inputImageMessages} message(s) ` +
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

        if (token.isCancellationRequested) return;

        // Convert resolved VS Code messages to DeepSeek format
        let deepseekMessages = vscodeMessagesToDeepSeek(resolvedMessages);

        // Truncate messages to fit within the configured context window
        deepseekMessages = truncateMessagesToContextWindow(deepseekMessages);

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
        const msg = `[Nika] Using model: ${modelId}${agentLabel}`;
        console.log(msg);
        getOutputChannel().appendLine(msg);

        const ctxWindowTokens = getContextWindowTokens();
        getOutputChannel().appendLine(`[Nika] Context window: ${ctxWindowTokens.toLocaleString()} tokens (setting: ${getContextWindowPreset()})`);

        const thinkingEffort = getThinkingEffort();
        const thinkingParams = buildThinkingParams(thinkingEffort);

        // When thinking mode is enabled, ensure enough headroom for reasoning
        // tokens. DeepSeek's thinking can consume 4K-16K+ tokens on reasoning
        // alone, leaving nothing for visible output if max_tokens is too low.
        const effectiveMaxTokens = getMaxTokens();
        const thinkingEnabled = getThinkingEffort() !== 'off';
        const minThinkingTokens = 16_384;
        const boostedTokens = thinkingEnabled
            ? Math.max(effectiveMaxTokens, minThinkingTokens)
            : effectiveMaxTokens;

        if (boostedTokens !== effectiveMaxTokens) {
            getOutputChannel().appendLine(
                `[Nika] Thinking mode enabled — boosting max_tokens from ` +
                `${effectiveMaxTokens.toLocaleString()} to ${boostedTokens.toLocaleString()} to leave room for reasoning`
            );
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
            request.tool_choice = 'auto';
        }

        // Detect incompatible parameter combinations
        const hasThinking = thinkingEnabled;
        const hasTools = (options.tools?.length ?? 0) > 0;
        if (hasThinking && hasTools) {
            const warning = `[Nika] WARNING: thinking mode (${getThinkingEffort()}) combined with ${options.tools!.length} tool(s). DeepSeek API may reject requests that include both thinking and tool parameters simultaneously. If you get a 400 error, try disabling thinking mode in settings.`;
            getOutputChannel().appendLine(warning);
            log.warn(warning);
        }

        // Validate message sequence order before sending
        const sequenceIssues = validateMessageSequence(deepseekMessages);
        if (sequenceIssues.length > 0) {
            const warning = `[Nika] WARNING: Message sequence validation found ${sequenceIssues.length} issue(s):\n  ${sequenceIssues.join('\n  ')}`;
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

        // Log request summary to nika.log
        const bodySize = new TextEncoder().encode(safeStringify(request)).length;
        log.info(
            `Sending DeepSeek request: model=${modelId}, ` +
            `messages=${deepseekMessages.length}, ` +
            `tools=${options.tools?.length ?? 0}, ` +
            `bodySize=${(bodySize / 1024).toFixed(1)}KB, ` +
            `thinking=${thinkingEnabled}, ` +
            `max_tokens=${boostedTokens.toLocaleString()}, ` +
            `temperature=${getTemperature()}`
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
                `Nika provider error (model: ${modelId}): ${errorMessage}`
            );
            // Preserve the original stack if available
            if (err instanceof Error && err.stack) {
                wrappedError.stack = err.stack;
            }

            // Log to nika.log for offline investigation
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
            throw new Error('Gemini API key not configured. Run "Nika: Input Gemini API Key" from the command palette.');
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
                getOutputChannel().appendLine(`[Nika] Gemini response: ${text.slice(0, 100)}...`);
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
                getOutputChannel().appendLine(`[Nika] Gemma4 response: ${text.slice(0, 100)}...`);
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
     * For Nika-native vision models (Gemini, Gemma4), we call the API directly
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

        visionLog.info(
            `Creating vision describer: visionModelKey=${visionModelKey ?? '(none)'}, ` +
            `visionModel=${oldVisionModel ?? '(none)'}`
        );

        // ── Nika-native models (direct API) ──────────────────────────
        if (visionModelKey?.startsWith('nika-')) {
            visionLog.info(`Using Nika direct describer for key: ${visionModelKey}`);
            return this.createNikaDirectDescriber(visionModelKey);
        }

        // Legacy visionModel setting
        if (!visionModelKey) {
            if (oldVisionModel === 'gemini-flash-lite') {
                visionLog.info('Using Gemini Flash-Lite (direct API)');
                return this.createDirectGeminiDescriber('gemini-2.5-flash-lite');
            }
            if (oldVisionModel === 'gemini' || !oldVisionModel) {
                visionLog.info('Using Gemini Flash (direct API)');
                return this.createDirectGeminiDescriber('gemini-2.5-flash');
            }
            if (oldVisionModel === 'ollama-gemma4') {
                visionLog.info('Using Gemma4 (direct Ollama API)');
                return this.createDirectGemma4Describer();
            }
        }

        // ── Copilot models (selectChatModels) ────────────────────────
        if (visionModelKey) {
            visionLog.info(`Trying Copilot vision model: ${visionModelKey}`);
            const describer = await resolveVisionDescriber({
                source: 'vscode-lm',
                visionModelKey,
            });
            if (describer) return describer;

            visionLog.warn(`Copilot vision model not found: "${visionModelKey}"`);
        }

        // ── Default fallback ─────────────────────────────────────────
        visionLog.info('Falling back to default: Gemini Flash (direct API)');
        return this.createDirectGeminiDescriber('gemini-2.5-flash');
    }

    /**
     * Create a direct Gemini describer that calls the Gemini API directly.
     * This is the Vizards "api-endpoint" pattern for Nika's built-in models.
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
     * Map a Nika provider key to a direct describer.
     */
    private async createNikaDirectDescriber(
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
     */
    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil(text.length / 4);
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

        return Math.ceil(content.length / 4);
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
    // Ensure it has `type: "object"` at minimum
    if (!schema.type || schema.type !== 'object') {
        return { ...schema, type: 'object' };
    }
    return schema;
}

/**
 * Build DeepSeek API thinking parameters from effort level.
 *
 * DeepSeek's API uses:
 *   thinking.type: "enabled" | "disabled"
 *   reasoning_effort: "high" | "max"
 *
 * Per the API docs, `low` and `medium` are mapped to `high` by the server,
 * and `xhigh` is mapped to `max`. We expose only the valid values directly.
 *
 * Effort levels:
 *   off  → thinking disabled
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
