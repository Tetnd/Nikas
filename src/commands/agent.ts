import * as vscode from 'vscode';
import { SecretStore } from '../secrets.js';
import { runAgent } from '../harness/index.js';
import { DEFAULT_TOOLSET } from '../harness/tools/index.js';
import { createEmbeddingsMatcher } from '../harness/embeddingMatcher.js';
import { createSemanticSearchTool } from '../tools/semanticSearch.js';
import { getSelectedModel, getThinkingEffort, getVirtualToolsEmbeddings, getVirtualToolsEmbeddingsThreshold } from '../config.js';
import { log } from '../log.js';
import { usageTracker } from '../usage/tracker.js';

/**
 * Invoker for the vscode-backed `semantic_search` harness tool: calls
 * Copilot's contributed codebase-search tool via `vscode.lm.invokeTool`
 * (stable API), bridging the harness's AbortSignal to a CancellationToken.
 * Throws when the API is unavailable (caller reports it as tool output).
 */
async function invokeCopilotTool(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const lm = vscode.lm as unknown as {
        invokeTool?: (n: string, o: { input?: unknown }, t?: vscode.CancellationToken) => Thenable<unknown>;
    };
    if (typeof lm.invokeTool !== 'function') {
        throw new Error('vscode.lm.invokeTool is unavailable in this VS Code build');
    }
    const cts = new vscode.CancellationTokenSource();
    const onAbort = signal?.addEventListener('abort', () => cts.cancel(), { once: true });
    try {
        return await lm.invokeTool(name, { input }, cts.token);
    } finally {
        (onAbort as (() => void) | undefined)?.();
        cts.dispose();
    }
}

/**
 * `Nikas: Run Agent` — surface the built-in agent harness as a command.
 *
 * Prompts for a task, then runs the self-contained agent loop (category
 * summarizer → virtual-tool scoping → model↔tools loop) against the selected
 * DeepSeek model in the current workspace. Output streams to a dedicated
 * "Nikas Agent" output channel and is also collected for the final result.
 *
 * This is a thin, additive command over the existing harness — it changes
 * nothing about the normal chat request path.
 */
export async function runAgentCommand(context: vscode.ExtensionContext): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Nikas Agent needs an open workspace folder.');
        return;
    }

    const task = await vscode.window.showInputBox({
        prompt: 'Task for the Nikas agent (it will read/search/write/run commands in the workspace)',
        placeHolder: 'e.g. Fix the TypeScript compile errors in src and run the tests',
        ignoreFocusOut: true,
    });
    if (!task || !task.trim()) return;

    const secrets = new SecretStore(context.secrets);
    const apiKey = await secrets.getDeepSeekApiKey();
    if (!apiKey) {
        vscode.window.showErrorMessage(
            'DeepSeek API key not configured. Run "Nikas: Input Deepseek userToken" first.'
        );
        return;
    }

    const channel = vscode.window.createOutputChannel('Nikas Agent');
    channel.show(true);
    channel.appendLine(`[Nikas Agent] Task: ${task}`);
    channel.appendLine(`[Nikas Agent] Cwd: ${folder.uri.fsPath}`);
    channel.appendLine('');

    const abort = new AbortController();
    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Nikas Agent running…',
            cancellable: true,
        },
        async (_progress, token) => {
            token.onCancellationRequested(() => abort.abort());
            const startedAt = Date.now();
            try {
                // D-10 (v0.7.88): optionally filter tools by embeddings relevance
                // (guarded — no-ops when the proposed API is unavailable).
                const matcher = getVirtualToolsEmbeddings()
                    ? createEmbeddingsMatcher()
                    : undefined;
                const agentResult = await runAgent(task, {
                    apiKey,
                    cwd: folder.uri.fsPath,
                    tools: [...DEFAULT_TOOLSET, createSemanticSearchTool({ invokeTool: invokeCopilotTool })],
                    alwaysShown: ['read_file', 'write_file', 'search_text', 'semantic_search'],
                    collapsible: ['run_terminal', 'run_tests'],
                    thinkingEffort: getThinkingEffort(),
                    signal: abort.signal,
                    maxIterations: 12,
                    maxParallel: 2,
                    matcher,
                    embeddingsThreshold: getVirtualToolsEmbeddingsThreshold(),
                    onText: (t) => channel.append(t),
                    onLog: (m) => channel.appendLine(`\n[agent] ${m}`),
                });
                // D-12 (v0.7.88): record the harness run in the usage tracker
                // (provider 'unknown', model = selected chat model) so agent runs
                // show up in the cost dashboard alongside chat requests.
                try {
                    usageTracker.record({
                        provider: 'unknown',
                        model: getSelectedModel(),
                        promptTokens: 0,
                        completionTokens: 0,
                        timestamp: Date.now(),
                        latencyMs: Date.now() - startedAt,
                        requestKind: 'harness-agent',
                    });
                } catch { /* additive */ }
                return agentResult;
            } catch (err) {
                channel.appendLine(
                    `\n[Nikas Agent] Failed: ${err instanceof Error ? err.message : String(err)}`
                );
                log.warn(`Agent run failed: ${err instanceof Error ? err.message : String(err)}`);
                return undefined;
            }
        }
    );

    channel.appendLine('');

    if (!result) {
        vscode.window.showWarningMessage('Nikas Agent did not complete (see the "Nikas Agent" output).');
        return;
    }

    channel.appendLine(
        `\n[Nikas Agent] Done — ${result.iterations} iteration(s), ${result.toolCalls} tool call(s).`
    );

    const action = await vscode.window.showInformationMessage(
        `Nikas Agent finished: ${result.iterations} iterations, ${result.toolCalls} tool calls.`,
        'Open Output'
    );
    if (action === 'Open Output') {
        channel.show(true);
    }
}
