import * as vscode from 'vscode';
import { NikaChatProvider } from './provider.js';
import { chooseProvider } from './commands/chooseProvider.js';
import { VISION_MODELS, getConfig, getOllamaBaseUrl } from './config.js';

/**
 * Nika VS Code Extension — DeepSeek language model provider for Copilot Chat.
 *
 * Provides:
 * - DeepSeek models in Copilot Chat's model picker (V4 Flash, V4 Pro)
 * - Configurable vision preprocessing for images (Gemma 4 / Gemini)
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
        vscode.commands.registerCommand('nika.chooseVisionModel', () => chooseVisionModel()),
        vscode.commands.registerCommand('nika.setOllamaHost', () => setOllamaHost()),
        vscode.commands.registerCommand('nika.manage', () => {
            vscode.window.showQuickPick(
                [
                    {
                        label: '$(list-tree) Choose Provider',
                        description: 'Select which DeepSeek model to use',
                    },
                    {
                        label: '$(eye) Choose Vision Model',
                        description: 'Select which vision model preprocesses images',
                    },
                    {
                        label: '$(key) Input Gemini API Key',
                        description: 'Set Gemini API key for vision/image support',
                    },
                    {
                        label: '$(server) Set Ollama Host',
                        description: 'Change Ollama server URL (for Gemma 4 vision)',
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
                    case '$(eye) Choose Vision Model':
                        vscode.commands.executeCommand('nika.chooseVisionModel');
                        break;
                    case '$(key) Input Gemini API Key':
                        inputGeminiToken(context);
                        break;
                    case '$(server) Set Ollama Host':
                        setOllamaHost();
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
 * Ollama host setter — lets user configure remote Ollama instances.
 */
async function setOllamaHost(): Promise<void> {
    const config = getConfig();
    const current = getOllamaBaseUrl();

    const url = await vscode.window.showInputBox({
        title: 'Nika: Ollama Host URL',
        prompt: 'Enter the Ollama server URL (e.g., http://192.168.1.100:11434)',
        value: current,
        placeHolder: 'http://localhost:11434',
        ignoreFocusOut: true,
        validateInput: (value) => {
            try {
                const u = new URL(value);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                    return 'URL must start with http:// or https://';
                }
                return null;
            } catch {
                return 'Invalid URL format';
            }
        },
    });

    if (!url) return;

    await config.update('ollamaBaseUrl', url.trim().replace(/\/$/, ''), vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Nika: Ollama host set to ${url.trim().replace(/\/$/, '')}`);
}

/**
 * Vision model picker — lets user choose between Gemma 4 and Gemini.
 */
async function chooseVisionModel(): Promise<void> {
    const config = getConfig();
    const current = config.get<string>('visionModel') ?? 'ollama-gemma4';

    const items: vscode.QuickPickItem[] = VISION_MODELS.map(m => ({
        label: m.id === current ? `$(check) ${m.name}` : `$(blank) ${m.name}`,
        description: m.description,
        detail: m.requiresApiKey ? 'Requires Gemini API key' : 'Runs locally via Ollama — no API key needed',
    }));

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Nika: Choose Vision Model',
        placeHolder: 'Select a vision model for image preprocessing',
        matchOnDescription: true,
    });

    if (!selected) return;

    const modelId = VISION_MODELS.find(m => selected.label.endsWith(m.name))?.id;
    if (modelId) {
        await config.update('visionModel', modelId, vscode.ConfigurationTarget.Global);
        const modelName = VISION_MODELS.find(m => m.id === modelId)?.name ?? modelId;
        vscode.window.showInformationMessage(`Nika: Selected ${modelName} for vision`);
    }
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
