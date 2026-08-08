import * as vscode from 'vscode';
import { SECRET_KEYS } from './config.js';

/**
 * Wraps vscode.SecretStorage for type-safe API key management.
 */
export class SecretStore {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async getDeepSeekApiKey(): Promise<string | undefined> {
        return this.secrets.get(SECRET_KEYS.deepseekApiKey);
    }

    async setDeepSeekApiKey(key: string): Promise<void> {
        await this.secrets.store(SECRET_KEYS.deepseekApiKey, key);
    }

    async deleteDeepSeekApiKey(): Promise<void> {
        await this.secrets.delete(SECRET_KEYS.deepseekApiKey);
    }

    async getGeminiApiKey(): Promise<string | undefined> {
        return this.secrets.get(SECRET_KEYS.geminiApiKey);
    }

    async setGeminiApiKey(key: string): Promise<void> {
        await this.secrets.store(SECRET_KEYS.geminiApiKey, key);
    }

    async deleteGeminiApiKey(): Promise<void> {
        await this.secrets.delete(SECRET_KEYS.geminiApiKey);
    }

    onDidChange(listener: (key: string) => void): vscode.Disposable {
        return this.secrets.onDidChange(e => {
            if (e.key.startsWith('nikas.')) {
                listener(e.key);
            }
        });
    }
}
