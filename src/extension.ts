import * as vscode from 'vscode';
import { NikaChatProvider } from './provider.js';
import { chooseProvider } from './commands/chooseProvider.js';

/**
 * Nika VS Code Extension — DeepSeek language model provider for Copilot Chat.
 *
 * Provides:
 * - DeepSeek models in Copilot Chat's model picker (V4 Flash, V4 Pro)
 * - Gemini-powered vision preprocessing for images
 * - Commands: Nika: Choose Provider, Nika: Manage
 */
export function activate(context: vscode.ExtensionContext) {
    const provider = new NikaChatProvider(context);

    // Register the language model chat provider — models appear in Copilot picker
    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('nika', provider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('nika.chooseProvider', () => chooseProvider()),
        vscode.commands.registerCommand('nika.manage', () => {
            vscode.window.showQuickPick(
                [
                    {
                        label: '$(list-tree) Choose Provider',
                        description: 'Select which DeepSeek model to use',
                    },
                    {
                        label: '$(key) Input Gemini API Key',
                        description: 'Set Gemini API key for vision/image support',
                    },
                    {
                        label: '$(link-external) Get Gemini API Key',
                        description: 'Open Google AI Studio to get a free Gemini API key',
                    },
                ],
                { title: 'Nika: Manage' }
            ).then(selection => {
                if (!selection) return;
                switch (selection.label) {
                    case '$(list-tree) Choose Provider':
                        vscode.commands.executeCommand('nika.chooseProvider');
                        break;
                    case '$(key) Input Gemini API Key':
                        inputGeminiToken(context);
                        break;
                    case '$(link-external) Get Gemini API Key':
                        vscode.env.openExternal(
                            vscode.Uri.parse('https://aistudio.google.com/apikey')
                        );
                        break;
                }
            });
        })
    );
}

/**
 * Prompt for Gemini API key (for vision preprocessing).
 */
async function inputGeminiToken(context: vscode.ExtensionContext): Promise<void> {
    const key = await vscode.window.showInputBox({
        title: 'Nika: Gemini API Key (for vision)',
        prompt: 'Enter your Gemini API key (free at https://aistudio.google.com/apikey)',
        password: true,
        placeHolder: 'AIza...',
        ignoreFocusOut: true,
    });

    if (!key) return;

    await context.secrets.store('nika.gemini.apiKey', key.trim());
    vscode.window.showInformationMessage(
        'Nika: Gemini API key saved! Image/vision support is now enabled.'
    );
}

export function deactivate() {
    // Cleanup handled by disposables in context.subscriptions
}
