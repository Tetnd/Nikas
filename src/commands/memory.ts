import * as vscode from 'vscode';
import { memoryStore, describeMemoryState } from '../memory/manager.js';

/**
 * `Nikas: Memory` — inspect persistent session memory.
 *
 * Opens the per-workspace nikas.md (if one exists) in the editor, or shows a
 * summary of what's stored. Purely informational — never modifies memory.
 */
export async function showMemory(): Promise<void> {
    const state = describeMemoryState();
    if (state.file) {
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(state.file));
            await vscode.window.showTextDocument(doc, { preview: true });
            return;
        } catch { /* fall through to the quick pick */ }
    }
    const entries = memoryStore.entries();
    const items: vscode.QuickPickItem[] = entries.map(e => ({
        label: `$(archive) ${e.key}`,
        description: `${e.source} · ${new Date(e.updatedAt).toLocaleString()}`,
        detail: e.summary.slice(0, 120) + (e.summary.length > 120 ? '…' : ''),
    }));
    if (items.length === 0) {
        items.push({ label: '$(info) No persistent session memory yet', description: 'Compaction summaries are saved here automatically' });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Persistent session memory (nikas.md)' });
    if (pick && pick.label.startsWith('$(archive)')) {
        // Reopen the nikas.md if it exists.
        if (state.file) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(state.file));
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch { /* ignore */ }
        }
    }
}

/** Wipe all persistent memory (with confirmation). */
export async function resetMemory(): Promise<void> {
    const yes = 'Clear Memory';
    const choice = await vscode.window.showWarningMessage(
        'Clear all persistent Nikas session memory? This cannot be undone.',
        { modal: true },
        yes
    );
    if (choice === yes) {
        memoryStore.reset();
        vscode.window.showInformationMessage('Nikas persistent session memory cleared.');
    }
}
