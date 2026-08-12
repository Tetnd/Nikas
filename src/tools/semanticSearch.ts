/**
 * VSCode-backed `semantic_search` tool for the Nikas agent harness.
 *
 * The harness's pure-Node toolset (`DEFAULT_TOOLSET`) only has lexical grep
 * (`search_text`) — no index, no natural-language search. This module closes
 * that gap by invoking COPILOT's own semantic codebase search tool
 * (`copilot_searchCodebase`, contributed by github.copilot-chat) via
 * `vscode.lm.invokeTool`. Copilot runs that tool against VS Code's workspace
 * chunk-search semantic index ("Codebase Semantic Index"), so the Nikas agent
 * gets true natural-language project search THROUGH Copilot without
 * reimplementing an index.
 *
 * Design notes:
 * - vscode-free core: the invoker is injected, so this module is unit-testable
 *   from plain Node (mirrors the rest of the harness).
 * - Tries several candidate tool names in order (the contributed name can
 *   change across Copilot builds): `copilot_searchCodebase` (current),
 *   `semantic_search`, `codebase` (reference names).
 * - Never throws to the model: missing tool / unavailable index / errors are
 *   returned as structured result text with actionable guidance, and the model
 *   can fall back to `search_text` for lexical search.
 */
import type { AgentTool } from '../harness/tools/index.js';

/** Injected `vscode.lm.invokeTool`-shaped call (keeps this module vscode-free). */
export type SemanticInvokeTool = (
    name: string,
    input: unknown,
    signal?: AbortSignal,
) => Promise<unknown>;

export interface SemanticSearchToolOptions {
    /** Invoker that calls `vscode.lm.invokeTool(name, { input }, token)`. */
    invokeTool: SemanticInvokeTool;
    /** Candidate contributed tool names, tried in order. Defaults to the known Copilot names. */
    toolNames?: string[];
}

/** Current + historical names of Copilot's codebase search tool. */
const DEFAULT_TOOL_NAMES = ['copilot_searchCodebase', 'semantic_search', 'codebase'];

/**
 * Extract the concatenated text from a `LanguageModelToolResult`-like object
 * (`{ content: Array<{ value: string } | ...> }`). Returns '' when there is no
 * text content (e.g. an empty result).
 */
export function extractResultText(result: unknown): string {
    const content = (result as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const p of content) {
        const rec = p as { value?: unknown } | null;
        if (rec && typeof rec.value === 'string') {
            parts.push(rec.value);
        } else if (rec && rec.value !== undefined && rec.value !== null) {
            try {
                const s = JSON.stringify(rec.value);
                if (s) parts.push(s);
            } catch { /* unstringifiable part — skip */ }
        }
    }
    return parts.join('\n').trim();
}

/** True when an invokeTool error means the tool name isn't registered. */
function isToolNotRegistered(message: string): boolean {
    return /(unknown tool|tool .*not (found|registered|exist|known)|does not exist)/i.test(message);
}

/** Build the `semantic_search` AgentTool. */
export function createSemanticSearchTool(opts: SemanticSearchToolOptions): AgentTool {
    const names = opts.toolNames && opts.toolNames.length > 0 ? opts.toolNames : DEFAULT_TOOL_NAMES;

    return {
        name: 'semantic_search',
        description:
            'Semantic search across the codebase using VS Code\'s codebase index (invokes Copilot\'s semantic search). ' +
            'Use natural language to find relevant code, symbols, or docs when you do not know exact strings. ' +
            'Prefer this over grep when you are unsure of the exact text to search for.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Natural-language description of what to find, ideally with terms likely to appear in the code.',
                },
            },
            required: ['query'],
        },
        execute: async (args, _cwd, signal) => {
            const query = typeof args.query === 'string' ? args.query.trim() : '';
            if (!query) {
                return '[error: semantic_search requires a non-empty "query" string (natural-language description of the code to find)]';
            }

            let lastError = '';
            for (const name of names) {
                try {
                    const result = await opts.invokeTool(name, { query }, signal);
                    const text = extractResultText(result);
                    if (text) return text;
                    return (
                        `[semantic search (${name}) returned no results] ` +
                        'If the Codebase Semantic Index is not built, run "Build Codebase Semantic Index" ' +
                        '(or check the "Codebase Semantic Index" status item) and retry — or use search_text for lexical search.'
                    );
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    lastError = msg;
                    // A non-registration error (auth, timeout, crash) is not going
                    // to succeed on a different name — report it directly.
                    if (!isToolNotRegistered(msg)) {
                        return `[semantic search failed via ${name}: ${msg}]`;
                    }
                }
            }
            return (
                `[semantic search unavailable: Copilot's codebase search tool is not registered in this VS Code (${lastError}). ` +
                'Enable "semantic search" in Configure Tools (workbench.action.chat.configureTools) and build the ' +
                'Codebase Semantic Index, or fall back to search_text for lexical search.]'
            );
        },
    };
}
