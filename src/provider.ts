import * as vscode from 'vscode';
import { SecretStore } from './secrets.js';
import { DEEPSEEK_MODELS, getConfig, getSelectedModel, getMaxTokens, getTemperature, ThinkingEffort, resolveModelId, resolveThinkingEffort } from './config.js';
import { vscodeMessagesToDeepSeek, hasImageParts } from './transform/messages.js';
import { streamDeepSeekChat } from './api/deepseek.js';
import { preprocessVision } from './vision/pipeline.js';
import { log } from './log.js';
import type { DeepSeekRequest, DeepSeekTool } from './api/types.js';

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

        return DEEPSEEK_MODELS.map(m => ({
            id: m.id,
            name: m.name,
            family: m.family,
            version: m.version,
            maxInputTokens: m.maxInputTokens,
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

        // Build the API request
        const config = getConfig();
        const modelId = resolveModelId(options.modelOptions, model);

        const thinkingEffort = resolveThinkingEffort(options.modelOptions, model);
        const thinkingParams = buildThinkingParams(thinkingEffort);

        const request: DeepSeekRequest = {
            model: modelId,
            messages: deepseekMessages,
            temperature: getTemperature(),
            max_tokens: getMaxTokens(),
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
            await streamDeepSeekChat(
                request,
                apiKey,
                abortController.signal,
                // onText — report each chunk to VS Code
                (text: string) => {
                    progress.report(new vscode.LanguageModelTextPart(text));
                },
                // onToolCalls — report tool calls
                (toolCalls) => {
                    for (const tc of toolCalls) {
                        progress.report(
                            new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.arguments)
                        );
                    }
                },
                // onComplete
                (_usage) => {
                    // Token usage could be logged or shown, but VS Code handles this
                }
            );
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
 * Map thinking effort level to DeepSeek API thinking parameters.
 *
 * Effort levels:
 *   off    → thinking disabled (default)
 *   low    → thinking enabled, 1024 token budget
 *   medium → thinking enabled, 4096 token budget
 *   high   → thinking enabled, 8192 token budget
 */
const THINKING_TOKEN_BUDGET: Record<ThinkingEffort, number | null> = {
    off: null,
    low: 1024,
    medium: 4096,
    high: 8192,
};

function buildThinkingParams(effort: ThinkingEffort): Partial<DeepSeekRequest> {
    if (effort === 'off') {
        return {
            thinking: { type: 'disabled' },
        };
    }

    const thinkingTokens = THINKING_TOKEN_BUDGET[effort];
    return {
        thinking: { type: 'enabled' },
        ...(thinkingTokens !== null ? { thinking_tokens: thinkingTokens } : {}),
    };
}
