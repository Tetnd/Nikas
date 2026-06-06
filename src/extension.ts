import * as vscode from 'vscode';
import { NikaChatProvider } from './provider.js';
import { chooseProvider } from './commands/chooseProvider.js';
import { checkForUpdates } from './commands/updateExtension.js';
import { VISION_MODELS, getConfig, getOllamaBaseUrl, THINKING_EFFORTS, DEEPSEEK_MODELS } from './config.js';

/**
 * Nika VS Code Extension — DeepSeek language model provider for Copilot Chat.
 *
 * Provides:
 * - DeepSeek models in Copilot Chat's model picker (V4 Flash, V4 Pro)
 * - Configurable vision preprocessing for images (Gemma 4 / Gemini)
 * - Commands: Nika: Choose Provider, Nika: Manage
 */
export async function activate(context: vscode.ExtensionContext) {
    const provider = new NikaChatProvider(context);

    // Register the language model chat provider — models appear in Copilot picker
    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('nika', provider)
    );

    // Check if DeepSeek API key is configured on startup
    const apiKey = await provider.getApiKey();
    if (!apiKey) {
        const setKeyNow = 'Set API Key';
        const response = await vscode.window.showWarningMessage(
            'Nika: DeepSeek API key not configured. The Nika models will not appear in the Copilot Chat model picker until you set your API key.',
            setKeyNow
        );
        if (response === setKeyNow) {
            inputDeepseekToken(context);
        }
    }

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('nika.chooseProvider', () => chooseProvider()),
        vscode.commands.registerCommand('nika.chooseVisionModel', () => chooseVisionModel()),
        vscode.commands.registerCommand('nika.setOllamaHost', () => setOllamaHost()),
        vscode.commands.registerCommand('nika.inputDeepseekToken', () => inputDeepseekToken(context)),
        vscode.commands.registerCommand('nika.chooseThinkingEffort', () => chooseThinkingEffort()),
        vscode.commands.registerCommand('nika.agentModelAssignments', () => agentModelAssignments()),
        vscode.commands.registerCommand('nika.checkForUpdates', () => checkForUpdates(context)),
        vscode.commands.registerCommand('nika.manage', () => {
            vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) Input DeepSeek API Key',
                        description: 'Set your DeepSeek API key (required for Nika to work)',
                    },
                    {
                        label: '$(list-tree) Choose Provider',
                        description: 'Select which DeepSeek model to use',
                    },
                    {
                        label: '$(eye) Choose Vision Model',
                        description: 'Select which vision model preprocesses images',
                    },
                    {
                        label: '$(symbol-parameter) Thinking Effort',
                        description: 'Set reasoning depth for thinking-capable models',
                    },
                    {
                        label: '$(symbol-misc) Agent Model Assignments',
                        description: 'Configure which model each Copilot agent uses (Explore, Plan, etc.)',
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
                        label: '$(link-external) Get DeepSeek API Key',
                        description: 'Open DeepSeek Platform to create an API key',
                    },
                    {
                        label: '$(link-external) Get Gemini API Key',
                        description: 'Open Google AI Studio to get a free Gemini API key',
                    },
                    {
                        label: '$(cloud-download) Check for Updates',
                        description: 'Download and install the latest version from GitHub',
                    },
                ],
                { title: 'Nika: Manage' }
            ).then(selection => {
                if (!selection) return;
                switch (selection.label) {
                    case '$(key) Input DeepSeek API Key':
                        inputDeepseekToken(context);
                        break;
                    case '$(list-tree) Choose Provider':
                        vscode.commands.executeCommand('nika.chooseProvider');
                        break;
                    case '$(eye) Choose Vision Model':
                        vscode.commands.executeCommand('nika.chooseVisionModel');
                        break;
                    case '$(symbol-parameter) Thinking Effort':
                        vscode.commands.executeCommand('nika.chooseThinkingEffort');
                        break;
                    case '$(symbol-misc) Agent Model Assignments':
                        vscode.commands.executeCommand('nika.agentModelAssignments');
                        break;
                    case '$(key) Input Gemini API Key':
                        inputGeminiToken(context);
                        break;
                    case '$(server) Set Ollama Host':
                        setOllamaHost();
                        break;
                    case '$(link-external) Get DeepSeek API Key':
                        vscode.env.openExternal(
                            vscode.Uri.parse('https://platform.deepseek.com/api_keys')
                        );
                        break;
                    case '$(link-external) Get Gemini API Key':
                        vscode.env.openExternal(
                            vscode.Uri.parse('https://aistudio.google.com/apikey')
                        );
                        break;
                    case '$(cloud-download) Check for Updates':
                        vscode.commands.executeCommand('nika.checkForUpdates');
                        break;
                }
            });
        })
    );
}

/**
 * Prompt for DeepSeek API key (required for Nika to work).
 */
async function inputDeepseekToken(context: vscode.ExtensionContext): Promise<void> {
    const key = await vscode.window.showInputBox({
        title: 'Nika: DeepSeek API Key',
        prompt: 'Enter your DeepSeek API key (from https://platform.deepseek.com/api_keys)',
        password: true,
        placeHolder: 'sk-...',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value.trim()) {
                return 'API key cannot be empty';
            }
            return null;
        },
    });

    if (!key) return;

    await context.secrets.store('nika.deepseek.apiKey', key.trim());
    vscode.window.showInformationMessage(
        'Nika: DeepSeek API key saved! The Nika models should now appear in the Copilot Chat model picker.'
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

/**
 * Thinking effort picker — controls reasoning depth for models that support it.
 */
async function chooseThinkingEffort(): Promise<void> {
    const config = getConfig();
    const current = config.get<string>('thinkingEffort') ?? 'off';

    const items: vscode.QuickPickItem[] = THINKING_EFFORTS.map(e => ({
        label: e.id === current ? `$(check) ${e.label}` : `$(blank) ${e.label}`,
        description: e.description,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Nika: Thinking Effort',
        placeHolder: 'Select reasoning depth (only applies to thinking-capable models)',
        matchOnDescription: true,
    });

    if (!selected) return;

    const effort = THINKING_EFFORTS.find(e => selected.label.endsWith(e.label))?.id;
    if (effort) {
        await config.update('thinkingEffort', effort, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Nika: Thinking effort set to ${effort}`);
    }
}

/**
 * Open VS Code settings to the agent model assignment section.
 * This exposes native settings like:
 *   - chat.exploreAgent.defaultModel
 *   - chat.planAgent.defaultModel
 *   - chat.utilityModel
 *   - chat.utilitySmallModel
 */
async function agentModelAssignments(): Promise<void> {
    const items: (vscode.QuickPickItem & { setting: string })[] = [
        { label: '$(search) Explore Agent', description: 'chat.exploreAgent.defaultModel — Model used by the Explore subagent', setting: 'chat.exploreAgent.defaultModel' },
        { label: '$(list-plan) Plan Agent', description: 'chat.planAgent.defaultModel — Model used by the Plan agent', setting: 'chat.planAgent.defaultModel' },
        { label: '$(tools) Utility Model', description: 'chat.utilityModel — Model for built-in utility flows', setting: 'chat.utilityModel' },
        { label: '$(rocket) Utility Small Model', description: 'chat.utilitySmallModel — Small/fast model for utility flows', setting: 'chat.utilitySmallModel' },
        { label: '$(settings-gear) All Chat Settings', description: 'Open all chat-related settings', setting: '@ext:github.copilot-chat' },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Nika: Agent Model Assignments',
        placeHolder: 'Select which agent model to configure',
        matchOnDescription: true,
    });

    if (!pick) return;

    if (pick.setting === '@ext:github.copilot-chat') {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:github.copilot-chat');
    } else {
        await vscode.commands.executeCommand('workbench.action.openSettings', pick.setting);
    }
}

export function deactivate() {
    // Cleanup handled by disposables in context.subscriptions
}
