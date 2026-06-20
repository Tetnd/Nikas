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
        maxInputTokens: 1_000_000,
        maxOutputTokens: 384_000,
        capabilities: { imageInput: true, toolCalling: true },
        detail: 'Fast, 284B MoE (13B active)',
    },
    {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        family: 'deepseek',
        version: '4.0.0',
        maxInputTokens: 1_000_000,
        maxOutputTokens: 384_000,
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

/**
 * Max output token presets.
 *
 * DeepSeek V4 models support up to 384K output tokens.
 * These presets let users choose the right balance of speed, cost, and output length.
 *
 * Thinking mode consumes tokens just on reasoning — use at least 16K when it's enabled.
 */
export type MaxTokensPreset = '4K' | '8K' | '16K' | '32K' | '64K' | '128K' | '384K';

export const MAX_TOKENS_PRESETS: { id: MaxTokensPreset; label: string; tokens: number; description: string; recommended: boolean; thinkingRecommended: boolean }[] = [
    { id: '4K', label: '4K', tokens: 4_096, description: 'Minimal — fastest, lowest cost. Good for simple Q&A and lookups, but easily truncated.', recommended: false, thinkingRecommended: false },
    { id: '8K', label: '8K', tokens: 8_192, description: 'Default — balanced for most conversations. Sufficient when thinking mode is off. Without thinking, the full budget goes to visible output.', recommended: true, thinkingRecommended: false },
    { id: '16K', label: '16K', tokens: 16_384, description: 'Thinking mode sweet spot — reserves ~8K for reasoning tokens while leaving ~8K for visible output. Prevents the "empty response" problem.', recommended: false, thinkingRecommended: true },
    { id: '32K', label: '32K', tokens: 32_768, description: 'Large responses — complex code generation, long-form content, detailed analysis with thinking.', recommended: false, thinkingRecommended: false },
    { id: '64K', label: '64K', tokens: 65_536, description: 'Very long outputs — document generation, large refactors, multi-step agent tasks.', recommended: false, thinkingRecommended: false },
    { id: '128K', label: '128K', tokens: 131_072, description: 'Extended — maximum practical for extended agent sessions with heavy tool use.', recommended: false, thinkingRecommended: false },
    { id: '384K', label: '384K', tokens: 384_000, description: 'Maximum — full DeepSeek V4 output capability. Only needed for extremely long generations.', recommended: false, thinkingRecommended: false },
];

export function getMaxTokensPreset(): MaxTokensPreset {
    return (getConfig().get<string>('maxTokens') as MaxTokensPreset) ?? '8K';
}

export function getMaxTokens(): number {
    const preset = getMaxTokensPreset();
    const found = MAX_TOKENS_PRESETS.find(p => p.id === preset);
    return found?.tokens ?? 8192;
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

export type ThinkingEffort = 'off' | 'high' | 'max';

export const THINKING_EFFORTS: { id: ThinkingEffort; label: string; description: string }[] = [
    { id: 'off', label: 'Off', description: 'No thinking mode — fastest responses' },
    { id: 'high', label: 'High', description: 'Standard reasoning (default for most requests)' },
    { id: 'max', label: 'Max', description: 'Maximum reasoning effort (used for complex agent tasks)' },
];

export function getThinkingEffort(): ThinkingEffort {
    return (getConfig().get<string>('thinkingEffort') as ThinkingEffort) ?? 'off';
}

/**
 * Context window presets.
 *
 * DeepSeek V4 models support up to 1M tokens of input context.
 * These presets let users cap the context to control costs and response speed.
 */
export type ContextWindowPreset = '32K' | '64K' | '128K' | '256K' | '512K' | '1M';

export const CONTEXT_WINDOW_PRESETS: { id: ContextWindowPreset; label: string; tokens: number; description: string; recommended: boolean }[] = [
    { id: '32K', label: '32K', tokens: 32_768, description: 'Minimal — most cost-efficient, fastest responses', recommended: false },
    { id: '64K', label: '64K', tokens: 65_536, description: 'Small — good for simple Q&A', recommended: false },
    { id: '128K', label: '128K', tokens: 131_072, description: 'Balanced — recommended default for most use cases', recommended: true },
    { id: '256K', label: '256K', tokens: 262_144, description: 'Large — for complex document analysis', recommended: false },
    { id: '512K', label: '512K', tokens: 524_288, description: 'Extra large — for very long conversations', recommended: false },
    { id: '1M', label: '1M', tokens: 1_000_000, description: 'Maximum — full DeepSeek context (recommended for complex agent tasks)', recommended: false },
];

export function getContextWindowPreset(): ContextWindowPreset {
    return (getConfig().get<string>('contextWindow') as ContextWindowPreset) ?? '128K';
}

export function getContextWindowTokens(): number {
    const preset = getContextWindowPreset();
    const found = CONTEXT_WINDOW_PRESETS.find(p => p.id === preset);
    return found?.tokens ?? 131_072;
}

// --- Log Level ---

export type LogLevel = 'OFF' | 'ERROR' | 'WARN' | 'INFO' | 'VERBOSE';

export const LOG_LEVELS: { id: LogLevel; label: string; description: string }[] = [
    { id: 'OFF', label: 'Off', description: 'No logging at all — completely silent' },
    { id: 'ERROR', label: 'Error', description: 'Only errors (crashes, API failures)' },
    { id: 'WARN', label: 'Warning', description: 'Errors and warnings (misconfigurations)' },
    { id: 'INFO', label: 'Info', description: 'Normal operational messages (default)' },
    { id: 'VERBOSE', label: 'Verbose', description: 'Detailed debugging (request/response bodies, message dumps)' },
];

export function getLogLevelSetting(): LogLevel {
    return (getConfig().get<string>('logLevel') as LogLevel) ?? 'INFO';
}
