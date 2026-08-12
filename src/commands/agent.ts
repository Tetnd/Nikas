import * as vscode from 'vscode';
import { SecretStore } from '../secrets.js';
import { runAgent } from '../harness/index.js';
import { DEFAULT_TOOLSET } from '../harness/tools/index.js';
import { getSelectedModel, getThinkingEffort } from '../config.js';
import { log } from '../log.js';

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
            try {
                const agentResult = await runAgent(task, {
                    apiKey,
                    cwd: folder.uri.fsPath,
                    tools: DEFAULT_TOOLSET,
                    alwaysShown: ['read_file', 'write_file', 'search_text'],
                    collapsible: ['run_terminal', 'run_tests'],
                    thinkingEffort: getThinkingEffort(),
                    signal: abort.signal,
                    maxIterations: 12,
                    maxParallel: 2,
                    onText: (t) => channel.append(t),
                    onLog: (m) => channel.appendLine(`\n[agent] ${m}`),
                });
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
