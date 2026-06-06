import * as vscode from 'vscode';

/**
 * Nika configuration keys and defaults.
 * API keys are stored via context.secrets (not here) for security.
 */
export const CONFIG_SECTION = 'nika';

export const SECRET_KEYS = {
    deepseekApiKey: 'nika.deepseek.apiKey',
    geminiApiKey: 'nika.gemini.apiKey',
} as const;

export const VISION_MODELS = [
    {
        id: 'ollama-gemma4',
        name: 'Gemma 4 (Ollama)',
        description: 'Local Gemma 4 vision model via Ollama',
        requiresApiKey: false,
    },
    {
        id: 'gemini',
        name: 'Gemini 2.5 Flash',
        description: 'Google Gemini 2.5 Flash (free tier) — best price-performance',
        requiresApiKey: true,
    },
    {
        id: 'gemini-flash-lite',
        name: 'Gemini 2.5 Flash-Lite',
        description: 'Google Gemini 2.5 Flash-Lite (free tier) — fastest, most cost-efficient',
        requiresApiKey: true,
    },
] as const;

export type VisionModelId = (typeof VISION_MODELS)[number]['id'];

export const DEEPSEEK_MODELS = [
    {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        family: 'deepseek',
        version: '4.0.0',
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        capabilities: { imageInput: true, toolCalling: true },
        detail: 'Fast, 284B MoE (13B active)',
    },
    {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        family: 'deepseek',
        version: '4.0.0',
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        capabilities: { imageInput: true, toolCalling: true },
        detail: 'Full-powered, supports thinking mode',
    },
] as const;

export function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

export function getSelectedModel(): string {
    return getConfig().get<string>('selectedModel') ?? 'deepseek-v4-flash';
}

export function getMaxTokens(): number {
    return getConfig().get<number>('maxTokens') ?? 8192;
}

export function getTemperature(): number {
    return getConfig().get<number>('temperature') ?? 0.7;
}

export function getVisionModel(): VisionModelId {
    return (getConfig().get<string>('visionModel') as VisionModelId) ?? 'ollama-gemma4';
}

export function getOllamaBaseUrl(): string {
    return getConfig().get<string>('ollamaBaseUrl') ?? 'http://localhost:11434';
}

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high';

export const THINKING_EFFORTS: { id: ThinkingEffort; label: string; description: string }[] = [
    { id: 'off', label: 'Off', description: 'No thinking mode — fastest responses' },
    { id: 'low', label: 'Low', description: 'Light thinking (1K token budget)' },
    { id: 'medium', label: 'Medium', description: 'Moderate thinking (4K token budget)' },
    { id: 'high', label: 'High', description: 'Deep thinking (8K token budget)' },
];

export function getThinkingEffort(): ThinkingEffort {
    return (getConfig().get<string>('thinkingEffort') as ThinkingEffort) ?? 'off';
}

export type AgentOverride = {
    model: string;
    thinkingEffort?: ThinkingEffort;
};

/**
 * Agent model overrides — maps agent names (e.g., 'explore', 'edit', 'chat')
 * to { model, thinkingEffort? }. Used to route fast agents to Flash and deep agents to Pro
 * with per-agent thinking control.
 */
export function getAgentModelOverrides(): Record<string, AgentOverride> {
    return getConfig().get<Record<string, AgentOverride>>('agentModelOverrides') ?? {};
}

/**
 * Resolve the effective model ID for a request, considering agent overrides.
 * Falls back to the globally selected model if no override matches.
 *
 * Checks `modelOptions` for agent identifiers passed by the caller.
 * VS Code's built-in agents (Explore, Edit, etc.) do NOT reliably populate
 * these keys — this works best when an extension explicitly passes agent info
 * via `sendRequest()` (e.g., subagents called from other agents).
 *
 * As a fallback, also checks if any override key matches the requested
 * `model.id` — this lets users set overrides like
 * `"deepseek-v4-pro": { "model": "deepseek-v4-flash" }` to redirect all
 * requests for a specific model.
 */
export function resolveModelId(
    modelOptions: { readonly [name: string]: any } | undefined,
    model?: vscode.LanguageModelChatInformation
): string {
    const overrides = getAgentModelOverrides();
    if (overrides) {
        // First pass: check modelOptions keys for agent identifiers
        if (modelOptions) {
            for (const key of ['agent', 'agentName', 'mode', 'agentId', 'subagent', 'requestInitiator']) {
                const agentName = modelOptions[key];
                if (typeof agentName === 'string' && overrides[agentName]?.model) {
                    return overrides[agentName].model;
                }
            }
        }

        // Second pass: check if the requested model.id matches an override key
        // This handles the case where VS Code's built-in agents don't pass
        // agent identifiers in modelOptions.
        if (model && overrides[model.id]?.model) {
            return overrides[model.id].model;
        }
    }
    return getSelectedModel();
}

/**
 * Resolve the effective thinking effort for a request, considering agent overrides.
 * Falls back to the globally configured thinking effort if no override matches.
 *
 * Checks `modelOptions` for agent identifiers, then falls back to checking
 * the requested `model.id` against override keys.
 */
export function resolveThinkingEffort(
    modelOptions: { readonly [name: string]: any } | undefined,
    model?: vscode.LanguageModelChatInformation
): ThinkingEffort {
    const overrides = getAgentModelOverrides();
    if (overrides) {
        // First pass: check modelOptions keys for agent identifiers
        if (modelOptions) {
            for (const key of ['agent', 'agentName', 'mode', 'agentId', 'subagent']) {
                const agentName = modelOptions[key];
                if (typeof agentName === 'string' && overrides[agentName]?.thinkingEffort) {
                    return overrides[agentName].thinkingEffort;
                }
            }
        }

        // Second pass: check if the requested model.id matches an override key
        if (model) {
            const modelOverride = overrides[model.id];
            if (modelOverride?.thinkingEffort) {
                return modelOverride.thinkingEffort;
            }
        }
    }
    return getThinkingEffort();
}
