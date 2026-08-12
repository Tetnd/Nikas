/**
 * D-11 (v0.7.88): contribute Nikas harness tools as VS Code language-model
 * tools SCOPED to Nikas models only — so they never leak to other vendors.
 *
 * Uses the proposed `lm.registerTool` with a `models` selector
 * (`github.copilot.languageModelToolSupportsModel`), guarded so it's a no-op
 * when the API isn't available or the setting is off. Gated by
 * `nikas.contributeTools` (default OFF).
 *
 * The tools wrap the harness's minimal, dependency-free executors (read_file,
 * write_file, search_text, run_tests) so users can invoke them from Copilot
 * chat while a Nikas model is active.
 */
import * as vscode from 'vscode';
import { DEFAULT_TOOLSET, type AgentTool } from '../harness/tools/index.js';
import { getConfig } from '../config.js';

/** Whether the proposed registerTool-with-models API is available. */
function registerToolAvailable(): boolean {
    try {
        const lm = vscode.lm as unknown as { registerTool?: unknown };
        return typeof lm.registerTool === 'function';
    } catch {
        return false;
    }
}

interface RegisteredLmTool {
    invoke(input: unknown, context: unknown, token: unknown): Promise<unknown>;
}

/** Wrap an AgentTool executor as a VS Code language-model tool invocation. */
function toLmTool(tool: AgentTool): RegisteredLmTool {
    return {
        async invoke(input, _context, _token) {
            const args = (input ?? {}) as Record<string, unknown>;
            const cwd = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) ?? process.cwd();
            try {
                const result = await tool.execute(args, cwd);
                return { output: result };
            } catch (err) {
                return { output: `[error] ${err instanceof Error ? err.message : String(err)}` };
            }
        },
    };
}

/** D-11 contribution (best-effort, gated by nikas.contributeTools). */
export function contributeNikasTools(context: vscode.ExtensionContext): void {
    if (!getConfig().get<boolean>('contributeTools')) return;
    if (!registerToolAvailable()) return;

    try {
        const lm = vscode.lm as unknown as {
            registerTool: (
                name: string,
                definition: Record<string, unknown>,
                tool: RegisteredLmTool,
            ) => vscode.Disposable;
        };
        const disposables: vscode.Disposable[] = [];
        for (const tool of DEFAULT_TOOLSET) {
            const definition: Record<string, unknown> = {
                name: `nika_${tool.name}`,
                displayName: `Nikas: ${tool.name}`,
                userDescription: tool.description,
                models: [{ vendor: 'nikas' }],
                inputSchema: {
                    type: 'object',
                    properties: (tool.parameters?.properties as Record<string, unknown>) ?? {},
                    required: (tool.parameters?.required as string[]) ?? [],
                },
            };
            disposables.push(lm.registerTool(definition.name as string, definition, toLmTool(tool)));
        }
        for (const d of disposables) context.subscriptions.push(d);
    } catch {
        // Proposed API unavailable or registration rejected — additive no-op.
    }
}
