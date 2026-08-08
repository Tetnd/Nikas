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
 * Fix: register DeepSeek as a BYOK "Custom Endpoint" in Copilot Chat's
 * chatLanguageModels.json (the same file the "Manage Language Models" dialog
 * writes). BYOK providers DO load in the agent window, so DeepSeek then
 * appears everywhere. This module ensures that entry exists, idempotently,
 * without touching the user's other providers.
 *
 * The model is added as `apiType: "responses"` pointed at DeepSeek's Responses
 * API (https://api.deepseek.com/responses) — the same endpoint the extension's
 * "DeepSeek V4 Flash (Responses)" model uses, with the calibrated 950K input
 * window (under the API's 1,048,576 hard ceiling).
 */

/** The DeepSeek custom-endpoint provider entry we ensure exists. */
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
 * Ensure the DeepSeek custom-endpoint entry exists in chatLanguageModels.json.
 *
 * Idempotent and non-destructive:
 *   - If the file is missing, creates it with the DeepSeek entry.
 *   - If an entry with vendor `customendpoint` and name `DeepSeek` already
 *     exists, keeps its apiKey and settings but ensures the flash model entry
 *     is present and correct.
 *   - All OTHER providers are preserved untouched.
 *   - If the file is invalid JSON, it is backed up and left alone (we never
 *     clobber a file we can't parse).
 *
 * Returns whether the file was modified and its path.
 */
export async function ensureDeepSeekCopilotByok(
    context: vscode.ExtensionContext
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
                `DeepSeek was NOT auto-registered. Fix the file manually or run "Nikas: Add DeepSeek to Copilot".`,
                err
            );
            return { changed: false, path: filePath };
        }
    }

    // Find an existing DeepSeek custom-endpoint entry.
    const existing = (providers as Record<string, unknown>[]).find(p =>
        p && p['vendor'] === 'customendpoint' && p['name'] === 'DeepSeek'
    );

    if (existing) {
        // Preserve the user's apiKey; ensure the model entry is correct.
        const models = (existing['models'] as Record<string, unknown>[]) ?? [];
        const hasFlash = models.some(m => m && m['id'] === 'deepseek-v4-flash');
        const hasCorrectUrl = models.some(m =>
            m && m['id'] === 'deepseek-v4-flash' && m['url'] === DEEPSEEK_PROVIDER.models[0].url
        );

        if (!hasFlash) {
            models.push({ ...DEEPSEEK_PROVIDER.models[0] });
        } else if (!hasCorrectUrl) {
            const idx = models.findIndex(m => m && m['id'] === 'deepseek-v4-flash');
            models[idx] = { ...DEEPSEEK_PROVIDER.models[0], ...models[idx] };
            models[idx]['url'] = DEEPSEEK_PROVIDER.models[0].url;
        }
        existing['models'] = models;
        if (!existing['apiType']) existing['apiType'] = 'responses';
    } else {
        providers.push({ ...DEEPSEEK_PROVIDER });
    }

    try {
        fs.writeFileSync(filePath, JSON.stringify(providers, null, 2) + '\n', 'utf8');
    } catch (err) {
        log.error(`Copilot BYOK: failed to write ${filePath}`, err);
        throw err;
    }

    log.info(
        `Copilot BYOK: ${existed ? 'updated' : 'created'} ${filePath} with DeepSeek custom-endpoint ` +
        `(deepseek-v4-flash, apiType=responses, 950K window)`
    );

    return { changed: true, path: filePath };
}

/**
 * Command handler — manually (re)add DeepSeek to Copilot's BYOK providers
 * and report the result to the user.
 */
export async function addDeepSeekToCopilot(context: vscode.ExtensionContext): Promise<void> {
    const { changed, path: filePath } = await ensureDeepSeekCopilotByok(context);
    if (changed) {
        const reload = 'Reload Window';
        const choice = await vscode.window.showInformationMessage(
            'Nikas: Added DeepSeek to Copilot\u2019s language models. Reload the window for it to appear in the model picker (including the agent window).',
            reload
        );
        if (choice === reload) {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } else {
        vscode.window.showInformationMessage(
            'Nikas: DeepSeek is already registered in Copilot\u2019s language models.'
        );
    }
    log.info(`Copilot BYOK path: ${filePath}`);
}
