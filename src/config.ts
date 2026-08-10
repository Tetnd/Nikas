import * as vscode from 'vscode';

/**
 * Nikas configuration keys and defaults.
 * API keys are stored via context.secrets (not here) for security.
 */
export const CONFIG_SECTION = 'nikas';

export const SECRET_KEYS = {
    deepseekApiKey: 'nikas.deepseek.apiKey',
    geminiApiKey: 'nikas.gemini.apiKey',
} as const;

/**
 * Settings that no longer exist (removed in v0.7.27 along with the
 * Vizards-derived behavior machinery they controlled: tool-list
 * stabilization + request-kind routing). They are inert — nothing reads them
 * — but leftover values can linger in a user's settings.json and confuse
 * them. `migrateRemovedSettings` (extension.ts) deletes them on activation.
 */
export const REMOVED_SETTINGS: ReadonlyArray<{ key: string; reason: string }> = [
    {
        key: 'experimental.stabilizeToolList',
        reason: 'tool-list stabilization removed in v0.7.27 for Nika-parity',
    },
    {
        key: 'routing.forceThinkingNone',
        reason: 'request-kind routing removed in v0.7.27 for Nika-parity',
    },
];

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

/**
 * DeepSeek V4 Flash exposed through the Responses API (POST /responses).
 *
 * Kept SEPARATE from DEEPSEEK_MODELS on purpose:
 * - The Responses API currently only supports `deepseek-v4-flash` (not Pro).
 * - `nikas.selectedModel` / "Nikas: Choose Provider" drives the chat-completions
 *   request model id, so this id must NOT be selectable there (the inline
 *   handler would send it to /chat/completions and get a 400).
 * - It is picked via Copilot Chat's model picker, where routing in
 *   `provideLanguageModelChatResponse` dispatches it to the /responses handler.
 */
export const DEEPSEEK_RESPONSES_MODEL = {
    id: 'deepseek-v4-flash-responses',
    name: 'DeepSeek V4 Flash (Responses)',
    family: 'deepseek',
    version: '0731',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: { imageInput: true, toolCalling: true },
    detail: 'Flash 0731 via the Responses API — agent-native tooling & server-side web search',
} as const;

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
    { id: '8K', label: '8K', tokens: 8_192, description: 'Fast, low cost — balanced for simple Q&A when thinking mode is off. Full budget goes to visible output.', recommended: false, thinkingRecommended: false },
    { id: '16K', label: '16K', tokens: 16_384, description: 'Default — thinking mode sweet spot. Reserves ~8K for reasoning tokens while leaving ~8K for visible output. Prevents the "empty response" problem.', recommended: true, thinkingRecommended: true },
    { id: '32K', label: '32K', tokens: 32_768, description: 'Large responses — complex code generation, long-form content, detailed analysis with thinking.', recommended: false, thinkingRecommended: false },
    { id: '64K', label: '64K', tokens: 65_536, description: 'Very long outputs — document generation, large refactors, multi-step agent tasks.', recommended: false, thinkingRecommended: false },
    { id: '128K', label: '128K', tokens: 131_072, description: 'Extended — maximum practical for extended agent sessions with heavy tool use.', recommended: false, thinkingRecommended: false },
    { id: '384K', label: '384K', tokens: 384_000, description: 'Maximum — full DeepSeek V4 output capability. Only needed for extremely long generations.', recommended: false, thinkingRecommended: false },
];

export function getMaxTokensPreset(): MaxTokensPreset {
    return (getConfig().get<string>('maxTokens') as MaxTokensPreset) ?? '16K';
}

export function getMaxTokens(): number {
    const preset = getMaxTokensPreset();
    const found = MAX_TOKENS_PRESETS.find(p => p.id === preset);
    return found?.tokens ?? 16384;
}

export function getTemperature(): number {
    return getConfig().get<number>('temperature') ?? 0.7;
}

/**
 * Whether to inject a "concise / no process narration" directive into agent
 * requests.
 *
 * In agent mode DeepSeek V4 Flash tends to NARRATE its process as visible
 * reply text ("Let me check...", "I'll search for...", "First I need to...")
 * instead of quietly calling tools and answering. This reads as "the agent is
 * spamming thinking as replies". The directive below tells it to stop doing
 * that — go straight to tool calls / concise answers — WITHOUT reducing the
 * tool set.
 *
 * Defaults to OFF to match upstream Nika (which has no such directive) — the
 * directive makes DeepSeek behave as a strict agentic coder, which many users
 * find "too strict" / different from Nika. Opt in via `nikas.concisePrompt`
 * if you prefer the terse agent behavior.
 */
export function getConcisePrompt(): boolean {
    return getConfig().get<boolean>('concisePrompt') ?? false;
}

/**
 * Whether invisible internal Copilot helper requests (chat titles, commit
 * messages, settings resolver, todo tracker, categorize_prompt, ...) should
 * run with thinking FORCED OFF regardless of `nikas.thinkingEffort`.
 *
 * - true  (default) — helpers never burn thinking tokens; the configured
 *   effort still applies to the real agent (the executor). This is the
 *   "executor max, helpers none" setup.
 * - false — Nika parity: every request (including helpers) runs at the
 *   configured thinking effort, exactly like upstream Nika (no routing).
 */
export function getHelperThinkingOff(): boolean {
    return getConfig().get<boolean>('helperThinkingOff') ?? true;
}

/**
 * The behavioral directive appended to the system prompt when
 * `nikas.concisePrompt` is enabled.
 *
 * This mirrors the core of Copilot's native `coding_agent_instructions`
 * system prompt (verified in the Copilot bundle 2026-08-09): persist
 * end-to-end, take action instead of proposing solutions, prefer edit tools,
 * batch read-only tool calls, don't give up, and (critically for DeepSeek)
 * ALWAYS commit to a tool call instead of narrating a plan. Copilot's own
 * models get this conditioning natively; DeepSeek needs it reinforced or it
 * tends to describe what it would do rather than do it. Costs ~180 tokens.
 */
export const CONCISE_PROMPT_DIRECTIVE =
    'You are a coding agent. Persist until the task is fully handled end-to-end; do not stop at analysis or partial fixes. ' +
    'Unless the user explicitly asks for a plan or a question, ASSUME they want you to make changes and RUN TOOLS to do it — outputting a proposed solution instead of acting is bad. ' +
    'Every turn must either call a tool or give a final result; never just describe what you would do. ' +
    'Never restate the same plan more than once — if you have already planned a step, EXECUTE it now with a tool call. ' +
    'Do not narrate your process or announce what you are about to do. Do not include filler like "Let me", "I will", "First", or "Now". ' +
    'Prefer the edit tools (replace_string_in_file / multi_replace_string_in_file) over rewriting whole files. ' +
    'Batch independent read-only calls (searches, file reads) together. ' +
    'Do not give up unless you are sure the request cannot be fulfilled with the tools you have; gather context first, then act. ' +
    'Repeating a plan in text instead of acting is a failure. ' +
    'Give only the final, concise result.';


export function getVisionModel(): VisionModelId {
    return (getConfig().get<string>('visionModel') as VisionModelId) ?? 'gemini';
}

/**
 * Vision source setting — how image descriptions are obtained.
 * - 'vscode-lm': Uses a Copilot vision model (selected via visionModelKey)
 * - 'api-endpoint': Uses a direct API endpoint
 */
export type VisionSource = 'vscode-lm' | 'api-endpoint';

export function getVisionSource(): VisionSource {
    return (getConfig().get<string>('visionSource') as VisionSource) ?? 'vscode-lm';
}

/**
 * The composite key of the selected VS Code LM vision model (vendor/id).
 * Only used when visionSource is 'vscode-lm'.
 */
export function getVisionModelKey(): string | undefined {
    const key = getConfig().get<string>('visionModelKey');
    return key?.trim() || undefined;
}

export function getOllamaBaseUrl(): string {
    return getConfig().get<string>('ollamaBaseUrl') ?? 'http://localhost:11434';
}

export type ThinkingEffort = 'off' | 'low' | 'high' | 'max';

export function getThinkingEffort(): ThinkingEffort {
    const value = getConfig().get<string>('thinkingEffort') as ThinkingEffort;
    // Guard against hand-edited settings.json values that aren't valid efforts
    // (e.g. 'xhigh' or a typo) — those would otherwise be sent to the API as
    // reasoning_effort and produce a 400.
    if (value === 'off' || value === 'low' || value === 'high' || value === 'max') {
        return value;
    }
    // Default to off — matches upstream Nika (the creator's default), so the
    // agent behaves identically to Nika out of the box. Users who want more
    // reasoning can opt into low/high/max via the nikas.thinkingEffort setting.
    return 'off';
}

/**
 * Whether sparse/image-based PDFs should be enriched with a vision-model
 * description (Gemini direct API reads `application/pdf` natively).
 *
 * Text extraction is the primary path — it's fast and free. But floor plans,
 * drawings, and scanned PDFs yield little or no text, so the model misses the
 * visual content. When local extraction is below `pdfVisionFallbackMinChars`,
 * Nikas describes the PDF via the configured vision describer and appends that
 * description to the extracted text. Falls back to plain text when no
 * direct-API (Gemini) describer is available. Default ON.
 */
export function getPdfVisionFallback(): boolean {
    return getConfig().get<boolean>('pdfVisionFallback') ?? true;
}

/**
 * Local text-extraction length (chars) below which a PDF is considered
 * sparse / image-based and triggers the Gemini vision fallback.
 * Default 3000 — scanned / image-heavy PDFs (floor plans, scans, drawings)
 * typically extract far less than this even when they contain some text
 * (a 2MB single-page scan commonly extracts only ~1.3K chars). A real text
 * PDF (contract, paper) yields far more, so text-rich docs skip the vision
 * call and stay on fast/free extraction.
 */
export function getPdfVisionFallbackMinChars(): number {
    const v = getConfig().get<number>('pdfVisionFallbackMinChars');
    return typeof v === 'number' && v >= 0 ? Math.floor(v) : 3000;
}

/**
 * Maximum number of PDF pages extracted when the user does NOT request a
 * specific page range. Huge PDFs (books, manuals) can be hundreds of pages
 * and would blow past the context window (~1K tokens/page → 600 pages ≈
 * 600K tokens ≫ 256K window). Default 60 — enough for typical documents
 * while leaving context for the conversation. When a page range is detected
 * in the message ("pages 100-150"), only that range is extracted regardless
 * of this cap. Set 0 for unlimited.
 */
export function getPdfMaxPages(): number {
    const v = getConfig().get<number>('pdfMaxPages');
    return typeof v === 'number' && v >= 0 ? Math.floor(v) : 60;
}

/**
 * When `pdfMaxPages` truncates a PDF, whether to tell the model how many
 * pages exist and that it can request a specific range. Default true.
 */
export function getPdfPageNotice(): boolean {
    return getConfig().get<boolean>('pdfPageNotice') ?? true;
}

/**
 * Context window presets.
 *
 * DeepSeek V4 models advertise up to 1M tokens of input context, but the API
 * enforces a HARD ceiling of 1,048,576 total tokens per request (input +
 * output). The max preset is therefore 950K, which keeps headroom below that
 * ceiling even with thinking mode burning reasoning tokens, and after the
 * token estimator was calibrated to real token counts (~1.4× the old ~4
 * chars/token estimate — see ESTIMATE_CALIBRATION in provider.ts).
 * These presets let users cap the context to control costs and response speed.
 */
export type ContextWindowPreset = '32K' | '64K' | '128K' | '256K' | '512K' | '950K';

export const CONTEXT_WINDOW_PRESETS: { id: ContextWindowPreset; label: string; tokens: number; description: string; recommended: boolean }[] = [
    { id: '32K', label: '32K', tokens: 32_768, description: 'Minimal — most cost-efficient, fastest responses', recommended: false },
    { id: '64K', label: '64K', tokens: 65_536, description: 'Small — good for simple Q&A', recommended: false },
    { id: '128K', label: '128K', tokens: 131_072, description: 'Balanced — good for most use cases', recommended: false },
    { id: '256K', label: '256K', tokens: 262_144, description: 'Default — large, for complex document analysis and long agent sessions', recommended: true },
    { id: '512K', label: '512K', tokens: 524_288, description: 'Extra large — for very long conversations', recommended: false },
    { id: '950K', label: '950K', tokens: 950_000, description: 'Maximum (safe): keeps headroom below the API\'s 1,048,576-token hard ceiling even with thinking mode (for extremely long sessions)', recommended: false },
];

export function getContextWindowPreset(): ContextWindowPreset {
    const value = getConfig().get<string>('contextWindow');
    // Legacy: the old "1M" preset is mapped to 950K so existing configs keep
    // working but stay under the API's 1,048,576-token hard ceiling (1M
    // estimated ≈ 1.4M real tokens → the API rejects those with HTTP 400).
    if (value === '1M') return '950K';
    return (value as ContextWindowPreset) ?? '256K';
}

export function getContextWindowTokens(): number {
    const preset = getContextWindowPreset();
    const found = CONTEXT_WINDOW_PRESETS.find(p => p.id === preset);
    return found?.tokens ?? 262_144;
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

// --- Log file rotation ---

/**
 * Max size (MB) of `nikas.log` before it is rotated to `nikas.log.1`
 * (then `.2`, `.3`, ...). Set 0 to disable size-based rotation.
 * Default 5 MB — prevents the log from ever growing to gigabytes.
 */
export function getLogMaxSizeMB(): number {
    const v = getConfig().get<number>('logMaxSizeMB');
    return typeof v === 'number' && v >= 0 ? v : 5;
}

/**
 * How many rotated log files (`nikas.log.1`, `nikas.log.2`, ...) to keep
 * before pruning the oldest. Set 0 to keep none (log is truncated instead).
 * Default 5.
 */
export function getLogMaxFiles(): number {
    const v = getConfig().get<number>('logMaxFiles');
    return typeof v === 'number' && v >= 0 ? Math.floor(v) : 5;
}

// --- Copilot Chat PDF patcher ---

/**
 * Whether the extension should auto-detect Copilot Chat updates and re-apply
 * the PDF patches (settings: `nikas.autoPatchCopilot`, default true).
 */
export function getAutoPatchEnabled(): boolean {
    return getConfig().get<boolean>('autoPatchCopilot') ?? true;
}

/**
 * Max file size (MB) Copilot Chat is patched to accept for attachments.
 * Patches the 5 MB hardcoded limit in the installed Copilot bundle.
 */
export function getCopilotMaxFileSizeMB(): number {
    const v = getConfig().get<number>('copilotMaxFileSizeMB');
    return typeof v === 'number' && v > 0 ? Math.floor(v) : 100;
}

/**
 * Whether to auto-reload the window right after re-applying patches
 * (vs. prompting the user). Default false — safer.
 */
export function getAutoReloadAfterPatch(): boolean {
    return getConfig().get<boolean>('autoReloadAfterPatch') ?? false;
}

/** Number of `.bak-*` bundle backups to retain. */
export function getPatchBackupRetention(): number {
    const v = getConfig().get<number>('patchBackupRetention');
    return typeof v === 'number' && v >= 0 ? Math.floor(v) : 5;
}

// --- Self-update ---

/**
 * GitHub repo (`owner/repo`) used for Nikas self-updates.
 * Points at this project's own fork by default.
 */
export function getUpdateRepo(): string {
    const v = getConfig().get<string>('updateRepo');
    return v?.trim() || 'Tetnd/Nikas';
}

/**
 * Whether Nikas periodically checks for its own updates on GitHub
 * (settings: `nikas.autoCheckUpdates`, default false — no repo yet).
 */
export function getAutoCheckUpdates(): boolean {
    return getConfig().get<boolean>('autoCheckUpdates') ?? false;
}
