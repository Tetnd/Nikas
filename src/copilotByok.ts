import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './log.js';

/**
 * Copilot Chat BYOK (chatLanguageModels.json) management.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nikas registers DeepSeek models into the IDE's Copilot Chat model picker via
 * a vscode.lm LanguageModelChatProvider — but the Copilot AGENT WINDOW
 * (activated via `onChatSession:copilotcli`) only loads GitHub's built-in
 * models and BYOK providers; it never activates third-party vscode.lm
 * providers. The result: DeepSeek works in normal chat but is missing from
 * the agent window's model picker.
 *
 * Fix: register the providers we need as BYOK "Custom Endpoint" entries in
 * Copilot Chat's chatLanguageModels.json (the same file the "Manage Language
 * Models" dialog writes). BYOK providers DO load in the agent window.
 *
 * Providers ensured:
 *   1. DeepSeek — `apiType: "responses"` at DeepSeek's Responses API
 *      (https://api.deepseek.com/responses), text-only (DeepSeek V4 has no
 *      native vision). This is the agent's main text/coding model, with the
 *      calibrated 950K input window (under the API's 1,048,576 hard ceiling).
 *   2. Gemini — `apiType: "chat"` at Google's OpenAI-compatible endpoint
 *      (https://generativelanguage.googleapis.com/v1beta/openai/chat/completions),
 *      vision-capable. The agent window has NO vision otherwise — Nikas's
 *      image-preprocessing pipeline (Gemini describes → DeepSeek gets text)
 *      is a vscode.lm path that does not run in agent windows. Gemini-BYOK
 *      is what lets screenshots/images work there.
 *
 * Both are ensured idempotently: only added when missing, user's apiKey refs
 * and other providers are preserved, invalid JSON is backed up and skipped.
 */

/** DeepSeek — text/coding model for the agent window (Responses API). */
const DEEPSEEK_PROVIDER = {
    name: 'DeepSeek',
    vendor: 'customendpoint',
    apiKey: '${input:chat.lm.secret.deepseek}',
    apiType: 'responses',
    models: [
        {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash (Responses)',
            url: 'https://api.deepseek.com/responses',
            toolCalling: true,
            vision: false,
            maxInputTokens: 950000,
            maxOutputTokens: 16384,
        },
    ],
};

/** Gemini — vision-capable model for the agent window (OpenAI-compatible chat). */
const GEMINI_PROVIDER = {
    name: 'Gemini',
    vendor: 'customendpoint',
    apiKey: '${input:chat.lm.secret.gemini}',
    apiType: 'chat',
    models: [
        {
            id: 'gemini-2.5-flash',
            name: 'Gemini 2.5 Flash (Vision)',
            url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            toolCalling: true,
            vision: true,
            maxInputTokens: 1000000,
            maxOutputTokens: 8192,
        },
    ],
};

/** All providers this module keeps in sync. */
const BYOK_TARGETS = [DEEPSEEK_PROVIDER, GEMINI_PROVIDER];

/**
 * Resolve the Copilot Chat BYOK config path.
 *
 * The file lives next to the extension's global storage:
 *   .../User/chatLanguageModels.json
 * and the global storage URI is .../User/globalStorage/<publisher>.<name>.
 * Walking up from the global storage dir lands on the User dir, which also
 * works for Cursor (its global storage sits under the Cursor User dir).
 */
export function resolveChatLanguageModelsPath(context: vscode.ExtensionContext): string {
    const globalStorage = context.globalStorageUri.fsPath; // .../User/globalStorage/nikas.nikas
    const userDir = path.dirname(path.dirname(globalStorage)); // .../User
    return path.join(userDir, 'chatLanguageModels.json');
}

/**
 * Ensure a provider entry exists in chatLanguageModels.json.
 *
 * Idempotent and non-destructive:
 *   - If the file is missing, creates it with the given providers.
 *   - If an entry with the same vendor+name already exists, keeps its apiKey
 *     and settings but ensures the target model entries are present/correct.
 *   - All OTHER providers are preserved untouched.
 *   - If the file is invalid JSON, it is backed up and left alone (we never
 *     clobber a file we can't parse).
 */
async function ensureProviders(
    context: vscode.ExtensionContext,
    targets: readonly (typeof DEEPSEEK_PROVIDER | typeof GEMINI_PROVIDER)[]
): Promise<{ changed: boolean; path: string }> {
    const filePath = resolveChatLanguageModelsPath(context);

    let providers: unknown[] = [];
    let existed = false;

    if (fs.existsSync(filePath)) {
        existed = true;
        let raw: string;
        try {
            raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) throw new Error('top-level value is not an array');
            providers = parsed;
        } catch (err) {
            // Back up the broken file and leave it alone — never destroy user data.
            const backup = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            try { fs.copyFileSync(filePath, backup); } catch { /* ignore */ }
            log.warn(
                `Copilot BYOK: chatLanguageModels.json is invalid JSON; backed up to ${backup} and left untouched. ` +
                `Providers were NOT auto-registered. Fix the file manually or run "Nikas: Add DeepSeek & Gemini to Copilot".`,
                err
            );
            return { changed: false, path: filePath };
        }
    }

    const list = providers as Record<string, unknown>[];

    for (const target of targets) {
        const existing = list.find(p =>
            p && p['vendor'] === target.vendor && p['name'] === target.name
        );

        if (existing) {
            // Preserve the user's apiKey; ensure the model entries are correct.
            const models = (existing['models'] as Record<string, unknown>[]) ?? [];
            for (const tm of target.models) {
                const hasModel = models.some(m => m && m['id'] === tm.id);
                const hasCorrectUrl = models.some(m =>
                    m && m['id'] === tm.id && m['url'] === tm.url
                );
                if (!hasModel) {
                    models.push({ ...tm });
                } else if (!hasCorrectUrl) {
                    const idx = models.findIndex(m => m && m['id'] === tm.id);
                    models[idx] = { ...tm, ...models[idx] };
                    models[idx]['url'] = tm.url;
                }
            }
            existing['models'] = models;
            if (!existing['apiType']) existing['apiType'] = target.apiType;
        } else {
            list.push({ ...target });
        }
    }

    try {
        fs.writeFileSync(filePath, JSON.stringify(providers, null, 2) + '\n', 'utf8');
    } catch (err) {
        log.error(`Copilot BYOK: failed to write ${filePath}`, err);
        throw err;
    }

    log.info(
        `Copilot BYOK: ${existed ? 'updated' : 'created'} ${filePath} with ` +
        targets.map(t => `${t.name} (${t.models[0].id}, apiType=${t.apiType})`).join(', ')
    );

    return { changed: true, path: filePath };
}

/** Ensure DeepSeek (and Gemini) are registered for Copilot's agent window. */
export function ensureDeepSeekCopilotByok(context: vscode.ExtensionContext): Promise<{ changed: boolean; path: string }> {
    return ensureProviders(context, BYOK_TARGETS);
}

/** Ensure only the Gemini vision provider is registered. */
export function ensureGeminiCopilotByok(context: vscode.ExtensionContext): Promise<{ changed: boolean; path: string }> {
    return ensureProviders(context, [GEMINI_PROVIDER]);
}

/**
 * Command handler — manually (re)add DeepSeek + Gemini to Copilot's BYOK
 * providers and report the result to the user.
 */
export async function addDeepSeekToCopilot(context: vscode.ExtensionContext): Promise<void> {
    const { changed, path: filePath } = await ensureDeepSeekCopilotByok(context);
    if (changed) {
        const reload = 'Reload Window';
        const choice = await vscode.window.showInformationMessage(
            'Nikas: Added DeepSeek & Gemini to Copilot\u2019s language models. Reload the window for them to appear in the model picker (including the agent window).',
            reload
        );
        if (choice === reload) {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } else {
        vscode.window.showInformationMessage(
            'Nikas: DeepSeek & Gemini are already registered in Copilot\u2019s language models.'
        );
    }
    log.info(`Copilot BYOK path: ${filePath}`);
}
