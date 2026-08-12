/**
 * Tool-description token budget (v0.7.86) — protects the context window in
 * agent mode, where tool schemas are the biggest hidden cost.
 *
 * PURE + vscode-free (unit-testable from plain Node, see test-tool-budget.js).
 *
 * DeepSeek agent requests carry 50+ tools; each description adds hundreds of
 * tokens. When the total tool-schema estimate exceeds the configured budget,
 * the longest descriptions are trimmed to a short keep-prefix (name is never
 * touched, parameters are never touched — only the prose description is
 * shortened, so tool-calling behavior is unchanged).
 *
 * Always additive + conservative: under budget → no-op; never throws.
 */

/**
 * A tool as seen by the budget trimmer. Supports BOTH tool shapes used by
 * Nikas:
 *  - Responses shape: `{ type:'function', name, description, parameters }`
 *  - Chat shape:      `{ type:'function', function: { name, description, parameters } }`
 * All fields optional so either shape structurally satisfies the interface;
 * the generic `trimToolDescriptions<T>` preserves the caller's element type.
 */
export interface ToolLike {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
}

export interface TrimResult<T extends ToolLike = ToolLike> {
    tools: T[];
    /** Number of descriptions that were shortened. */
    trimmed: number;
    /** Approx tokens freed by trimming. */
    savedTokens: number;
    /** Approx total tokens of the tool set (before trimming). */
    totalTokens: number;
    /** True when trimming stopped early because everything was already minimal. */
    saturated: boolean;
}

/** Default per-tool minimum description length kept after trimming. */
export const MIN_KEEP_CHARS = 120;
/** Default total tool-schema budget (tokens). */
export const DEFAULT_TOOL_BUDGET_TOKENS = 12_000;

/** Name accessor (handles both tool shapes). */
function toolName(t: ToolLike): string {
    return t.name ?? t.function?.name ?? '';
}

/** Description accessor (handles both tool shapes). */
function toolDescription(t: ToolLike): string {
    return t.description ?? t.function?.description ?? '';
}

/** Parameters accessor (handles both tool shapes). */
function toolParameters(t: ToolLike): Record<string, unknown> {
    return (t.parameters ?? t.function?.parameters ?? {}) as Record<string, unknown>;
}

/** Description setter — writes into whichever shape the tool uses. */
function setToolDescription(t: ToolLike, text: string): void {
    if (t.function) {
        t.function.description = text;
    } else {
        t.description = text;
    }
}

/** Cheap token estimate: chars / 4 (matches the rest of Nikas). */
export function estimateToolTokens(tools: readonly ToolLike[]): number {
    let chars = 0;
    for (const t of tools) {
        chars += toolName(t).length + toolDescription(t).length;
        try {
            chars += JSON.stringify(toolParameters(t)).length;
        } catch {
            chars += 64; // unstringifiable parameters — assume a floor
        }
    }
    return Math.ceil(chars / 4);
}

/**
 * Trim tool descriptions so the whole tool set fits within `budgetTokens`.
 *
 * Strategy: while over budget, shorten the LONGEST not-yet-trimmed
 * description to a short keep-prefix (`name: <first MIN_KEEP_CHARS chars>…`).
 * Parameters and names are preserved verbatim — only prose descriptions are
 * shortened, so tool-calling behavior is unchanged.
 *
 * @param tools        the tool set (DeepSeekTool- or DeepSeekResponsesTool-shaped)
 * @param opts         budgetTokens (default 12_000), minKeepChars (default 120)
 */
export function trimToolDescriptions<T extends ToolLike>(tools: readonly T[], opts: { budgetTokens?: number; minKeepChars?: number } = {}): TrimResult<T> {
    const source = Array.isArray(tools) ? tools : [];
    const budget = typeof opts.budgetTokens === 'number' && opts.budgetTokens > 0 ? opts.budgetTokens : DEFAULT_TOOL_BUDGET_TOKENS;
    const minKeep = typeof opts.minKeepChars === 'number' && opts.minKeepChars > 0 ? Math.floor(opts.minKeepChars) : MIN_KEEP_CHARS;

    if (source.length === 0) {
        return { tools: [], trimmed: 0, savedTokens: 0, totalTokens: 0, saturated: false };
    }

    const totalTokens = estimateToolTokens(source);
    if (totalTokens <= budget) {
        return { tools: [...source], trimmed: 0, savedTokens: 0, totalTokens, saturated: false };
    }

    // Work on copies; track which tools were trimmed and by how much.
    const result: T[] = source.map(t => ({ ...t }));
    const trimmed = new Set<number>();
    let savedTokens = 0;

    for (;;) {
        const current = estimateToolTokens(result);
        if (current <= budget) break;

        // Find the longest untrimmed description (trimming the biggest first
        // frees the most tokens per pass).
        let target = -1;
        let longest = -1;
        for (let i = 0; i < result.length; i++) {
            if (trimmed.has(i)) continue;
            const len = toolDescription(result[i]).length;
            if (len > longest) {
                longest = len;
                target = i;
            }
        }
        if (target === -1) {
            // Everything already minimal — can't free more.
            return { tools: result, trimmed: trimmed.size, savedTokens, totalTokens, saturated: true };
        }

        const t = result[target];
        const before = toolDescription(t).length;
        const prefix = toolName(t) + ': ';
        const cut = (toolDescription(t) || '').slice(0, minKeep);
        setToolDescription(t, cut.trim().length === 0 ? prefix : cut);
        const after = toolDescription(t).length;
        savedTokens += Math.ceil((before - after) / 4);
        trimmed.add(target);
    }

    return { tools: result, trimmed: trimmed.size, savedTokens, totalTokens, saturated: false };
}
