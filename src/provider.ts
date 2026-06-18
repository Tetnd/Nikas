import * as vscode from 'vscode';
import { SecretStore } from './secrets.js';
import { DEEPSEEK_MODELS, getConfig, getSelectedModel, getMaxTokens, getTemperature, ThinkingEffort, getThinkingEffort, getContextWindowTokens, getContextWindowPreset } from './config.js';
import { vscodeMessagesToDeepSeek, hasImageParts } from './transform/messages.js';
import { streamDeepSeekChat } from './api/deepseek.js';
import { preprocessVision } from './vision/pipeline.js';
import { log } from './log.js';
import type { DeepSeekRequest, DeepSeekTool, DeepSeekMessage } from './api/types.js';

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
 * NikaChatProvider — a VS Code LanguageModelChatProvider for DeepSeek.
 *
 * Registered via vscode.lm.registerLanguageModelChatProvider('nika', provider).
 * Models appear in Copilot Chat's model picker dropdown.
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

    /**
     * Returns the list of available models. Called by VS Code when the model picker opens.
     * When `silent: true` and no API key is configured, returns an empty array
     * (to avoid prompting during startup).
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const apiKey = await this.secrets.getDeepSeekApiKey();

        if (!apiKey) {
            if (!options.silent) {
                vscode.window.showWarningMessage(
                    'Nika: DeepSeek API key not configured. The Nika models will not appear in the model picker until the key is set.'
                );
            }
            return [];
        }

        const effectiveInputTokens = getContextWindowTokens();

        return DEEPSEEK_MODELS.map(m => ({
            id: m.id,
            name: m.name,
            family: m.family,
            version: m.version,
            maxInputTokens: Math.min(m.maxInputTokens, effectiveInputTokens),
            maxOutputTokens: m.maxOutputTokens,
            capabilities: m.capabilities,
            detail: m.detail,
        })) as vscode.LanguageModelChatInformation[];
    }

    /**
     * Handle a chat request. This is the core method — it:
     * 1. Gets the API key
     * 2. Transforms VS Code messages to DeepSeek format
     * 3. Preprocesses any images via the configured vision model (Gemma 4 / Gemini)
     * 4. Streams the response back via `progress.report()`
     */
    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const apiKey = await this.secrets.getDeepSeekApiKey();
        if (!apiKey) {
            throw new Error(
                'DeepSeek API key not configured. Run "Nika: Input Deepseek userToken" from the command palette (F1).'
            );
        }

        // Check for cancellation
        if (token.isCancellationRequested) return;

        // Transform messages to DeepSeek format
        let deepseekMessages = vscodeMessagesToDeepSeek(messages);

        // Vision preprocessing — if images are present, send to Gemini
        if (hasImageParts(messages)) {
            const result = await preprocessVision(messages, deepseekMessages, this.secrets, progress, token);
            deepseekMessages = result.messages;

            if (result.errors.length > 0 && result.errors.length === result.errors.length) {
                // All images failed — warn and proceed with text-only
                progress.report(
                    new vscode.LanguageModelTextPart(
                        `\n\n⚠️ Unable to process images: ${result.errors.join('; ')}\n\n`
                    )
                );
            }
        }

        if (token.isCancellationRequested) return;

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
