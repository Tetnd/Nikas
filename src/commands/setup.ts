import * as vscode from 'vscode';
import { getConfig, getVisionModelKey, getOllamaBaseUrl, VISION_MODELS } from '../config.js';

/**
 * Nikas first-run setup wizard.
 *
 * Guides a brand-new user through the minimum steps needed to start
 * chatting with DeepSeek in Copilot Chat:
 *
 *   1. Set the DeepSeek API key (required — Nikas models won't appear without it)
 *   2. Choose a vision provider (optional — for image support)
 *   3. Choose the chat model (optional — defaults to DeepSeek V4 Flash)
 *
 * The wizard is non-blocking and can be re-run any time via the
 * "Nikas: Setup" command or by clicking the status bar item.
 */

export interface SetupState {
    hasDeepSeekKey: boolean;
    hasGeminiKey: boolean;
    selectedModel: string;
    visionModel: string | undefined;
    visionModelKey: string | undefined;
}

/** Read the current setup state from secrets + config. */
export async function getSetupState(context: vscode.ExtensionContext): Promise<SetupState> {
    const deepseekKey = await context.secrets.get('nikas.deepseek.apiKey');
    const geminiKey = await context.secrets.get('nikas.gemini.apiKey');
    const config = getConfig();
    return {
        hasDeepSeekKey: !!deepseekKey,
        hasGeminiKey: !!geminiKey,
        selectedModel: config.get<string>('selectedModel') ?? 'deepseek-v4-flash',
        visionModel: config.get<string>('visionModel') ?? undefined,
        visionModelKey: getVisionModelKey(),
    };
}

/** True when the minimum required setup (a DeepSeek key) is present. */
export function isConfigured(state: SetupState): boolean {
    return state.hasDeepSeekKey;
}

/**
 * Run the interactive setup wizard. Presents a checklist of setup items,
 * letting the user complete the ones they haven't done yet.
 */
export async function runSetup(context: vscode.ExtensionContext): Promise<void> {
    const state = await getSetupState(context);

    const items: vscode.QuickPickItem[] = [
        {
            label: state.hasDeepSeekKey
                ? '$(check) DeepSeek API Key — configured'
                : '$(key) Set DeepSeek API Key',
            description: state.hasDeepSeekKey
                ? 'Required for chat — already set ✅'
                : 'Required — needed before Nikas models appear in the model picker',
        },
        {
            label: state.hasGeminiKey
                ? '$(check) Vision provider — Gemini configured'
                : state.visionModel === 'ollama-gemma4'
                    ? '$(check) Vision provider — Gemma 4 (Ollama)'
                    : '$(eye) Choose vision provider',
            description: 'Optional — enables image support in chat',
        },
        {
            label: '$(list-tree) Choose chat model',
            description: `Current: ${state.selectedModel} (defaults to DeepSeek V4 Flash)`,
        },
        {
            label: '$(link-external) Get a DeepSeek API Key',
            description: 'Open platform.deepseek.com to create a key (free credits on signup)',
        },
        {
            label: '$(book) How to use Nikas',
            description: 'Show a quick guide on selecting the model in Copilot Chat',
        },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Nikas: Setup',
        placeHolder: state.hasDeepSeekKey
            ? 'You are set up! Pick an option to review or change.'
            : 'Welcome to Nikas! Complete the steps below to start chatting with DeepSeek.',
        matchOnDescription: true,
    });

    if (!pick) return;

    if (pick.label.includes('Set DeepSeek API Key')) {
        await inputDeepSeekKey(context);
        // Re-run so the user can continue with the next step.
        return runSetup(context);
    }

    if (pick.label.includes('Choose vision provider') || pick.label.includes('Vision provider')) {
        await chooseVisionProvider(context);
        return runSetup(context);
    }

    if (pick.label.includes('Choose chat model')) {
        await vscode.commands.executeCommand('nikas.chooseProvider');
        return runSetup(context);
    }

    if (pick.label.includes('Get a DeepSeek API Key')) {
        await vscode.env.openExternal(
            vscode.Uri.parse('https://platform.deepseek.com/api_keys')
        );
        return runSetup(context);
    }

    if (pick.label.includes('How to use Nikas')) {
        await showHowToUse();
        return runSetup(context);
    }
}

/**
 * Prompt for and store the DeepSeek API key.
 * Shared with the legacy "Input DeepSeek API Key" command.
 */
async function inputDeepSeekKey(context: vscode.ExtensionContext): Promise<void> {
    const key = await vscode.window.showInputBox({
        title: 'Nikas: DeepSeek API Key',
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

    await context.secrets.store('nikas.deepseek.apiKey', key.trim());
    vscode.window.showInformationMessage(
        'Nikas: DeepSeek API key saved! The Nikas models should now appear in the Copilot Chat model picker.'
    );
}

/**
 * Vision provider picker — a simplified version of "Choose Vision Model"
 * that only offers the Nikas-native options (Gemini / Gemma 4) plus a
 * "skip for now" escape hatch. Copilot models remain available via the
 * full "Nikas: Choose Vision Model" command.
 */
async function chooseVisionProvider(context: vscode.ExtensionContext): Promise<void> {
    const config = getConfig();
    const current = config.get<string>('visionModel');

    const items: vscode.QuickPickItem[] = [
        {
            label: current === 'gemini' ? '$(check) Gemini 2.5 Flash (cloud)' : '$(blank) Gemini 2.5 Flash (cloud)',
            description: 'Free Google AI Studio tier — needs a Gemini API key',
            detail: 'Best quality, cloud-based, no local install',
        },
        {
            label: current === 'gemini-flash-lite' ? '$(check) Gemini 2.5 Flash-Lite (cloud)' : '$(blank) Gemini 2.5 Flash-Lite (cloud)',
            description: 'Free Google AI Studio tier — needs a Gemini API key',
            detail: 'Fastest, most cost-efficient cloud option',
        },
        {
            label: current === 'ollama-gemma4' ? '$(check) Gemma 4 (local, Ollama)' : '$(blank) Gemma 4 (local, Ollama)',
            description: 'Runs on your machine — no API key needed',
            detail: 'Private/local, requires Ollama installed',
        },
        {
            label: '$(circle-slash) Skip for now',
            description: 'You can add vision support later',
        },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Nikas: Setup — Vision Provider',
        placeHolder: 'Image support is optional. Pick a provider or skip.',
        matchOnDescription: true,
    });

    if (!pick) return;

    if (pick.label.includes('Skip')) {
        return;
    }

    if (pick.label.includes('Gemini 2.5 Flash-Lite')) {
        await config.update('visionModel', 'gemini-flash-lite', vscode.ConfigurationTarget.Global);
        await config.update('visionModelKey', undefined, vscode.ConfigurationTarget.Global);
        await ensureGeminiKey(context);
        return;
    }

    if (pick.label.includes('Gemini 2.5 Flash (cloud)')) {
        await config.update('visionModel', 'gemini', vscode.ConfigurationTarget.Global);
        await config.update('visionModelKey', undefined, vscode.ConfigurationTarget.Global);
        await ensureGeminiKey(context);
        return;
    }

    if (pick.label.includes('Gemma 4')) {
        await config.update('visionModel', 'ollama-gemma4', vscode.ConfigurationTarget.Global);
        await config.update('visionModelKey', undefined, vscode.ConfigurationTarget.Global);
        const ollama = getOllamaBaseUrl();
        const confirm = await vscode.window.showInformationMessage(
            `Nikas: Gemma 4 selected. Make sure Ollama is installed and the model is pulled.\n\n` +
            `Install Ollama from https://ollama.com, then run:  ollama pull gemma4:31b\n\n` +
            `Current Ollama host: ${ollama}`,
            { modal: true },
            'Open Ollama Website'
        );
        if (confirm === 'Open Ollama Website') {
            await vscode.env.openExternal(vscode.Uri.parse('https://ollama.com'));
        }
        return;
    }
}

/** If the user picked a Gemini vision option, make sure they have a key. */
async function ensureGeminiKey(context: vscode.ExtensionContext): Promise<void> {
    const existing = await context.secrets.get('nikas.gemini.apiKey');
    if (existing) {
        vscode.window.showInformationMessage(
            'Nikas: Gemini selected for vision. ✅'
        );
        return;
    }

    const getKey = 'Get a free key';
    const choice = await vscode.window.showInformationMessage(
        'Nikas: Gemini vision needs a free API key from Google AI Studio.',
        getKey,
        'Enter Key'
    );

    if (choice === getKey) {
        await vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/apikey'));
    }

    const key = await vscode.window.showInputBox({
        title: 'Nikas: Gemini API Key (for vision)',
        prompt: 'Paste your Gemini API key (free at https://aistudio.google.com/apikey)',
        password: true,
        placeHolder: 'AIza...',
        ignoreFocusOut: true,
    });

    if (!key) {
        vscode.window.showWarningMessage(
            'Nikas: No Gemini key entered. Vision will not work until you add one — run "Nikas: Setup" anytime.'
        );
        return;
    }

    await context.secrets.store('nikas.gemini.apiKey', key.trim());
    vscode.window.showInformationMessage(
        'Nikas: Gemini API key saved! Image/vision support is now enabled. ✅'
    );
}

/** Show a concise how-to-use guide for a fresh user. */
async function showHowToUse(): Promise<void> {
    const openChat = 'Open Copilot Chat';
    const choice = await vscode.window.showInformationMessage(
        'Nikas: How to use\n\n' +
        '1. Open Copilot Chat (Ctrl+Shift+I)\n' +
        '2. Click the model picker dropdown at the top of the chat\n' +
        '3. Select DeepSeek V4 Flash (or Pro)\n' +
        '4. Start chatting!\n\n' +
        'You can attach images (vision) and PDFs (auto-patched) in chat.',
        openChat
    );
    if (choice === openChat) {
        await vscode.commands.executeCommand('workbench.action.chat.open');
    }
}

/**
 * Create the status bar item that reflects setup state.
 * Returns the item so callers can manage its lifecycle.
 */
export function createSetupStatusBarItem(): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );
    item.command = 'nikas.setup';
    item.tooltip = 'Nikas: Open setup wizard';
    return item;
}

/** Update the status bar item text/color based on the current setup state. */
export function updateSetupStatusBar(
    item: vscode.StatusBarItem,
    state: SetupState
): void {
    if (isConfigured(state)) {
        item.text = '$(check) Nikas: Ready';
        item.backgroundColor = undefined;
        item.tooltip = 'Nikas is configured. Click to manage or re-run setup.';
    } else {
        item.text = '$(alert) Nikas: Set up';
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        item.tooltip = 'Nikas needs a DeepSeek API key. Click to set it up.';
    }
    item.show();
}

/** Reusable list of vision providers for the setup flow. */
export const SETUP_VISION_MODELS = VISION_MODELS;
