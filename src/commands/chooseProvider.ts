import * as vscode from 'vscode';
import { DEEPSEEK_MODELS, getConfig } from '../config.js';

/**
 * "Nika: Choose Provider" command.
 *
 * Opens a QuickPick to select the active DeepSeek model.
 * The selection is persisted in VS Code settings.
 */
export async function chooseProvider(): Promise<void> {
    const config = getConfig();
    const currentModel = config.get<string>('selectedModel') ?? 'deepseek-v4-flash';

    const items: vscode.QuickPickItem[] = DEEPSEEK_MODELS.map(m => ({
        label: m.id === currentModel ? `$(check) ${m.name}` : `$(blank) ${m.name}`,
        description: m.detail,
        detail: `Max output: ${m.maxOutputTokens.toLocaleString()} tokens · Input: ${m.maxInputTokens.toLocaleString()} tokens`,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Nika: Choose Provider',
        placeHolder: 'Select a DeepSeek model',
        matchOnDescription: true,
    });

    if (!selected) return;

    // Find which model was picked (strip the check/blank icon prefix)
    const modelId = DEEPSEEK_MODELS.find(m =>
        selected.label.endsWith(m.name)
    )?.id;

    if (modelId) {
        await config.update('selectedModel', modelId, vscode.ConfigurationTarget.Global);
        const modelName = DEEPSEEK_MODELS.find(m => m.id === modelId)?.name ?? modelId;
        vscode.window.showInformationMessage(`Nika: Selected ${modelName}`);
    }
}
