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
