/**
 * Persistent session memory — vscode wiring.
 *
 * Bridges the pure MemoryStore (src/memory/store.ts) with VS Code:
 *   - Resolves the current workspace folder to a stable workspaceKey + the
 *     per-workspace `nikas.md` path.
 *   - Wires persistence: after every mutation the store is written to a
 *     human-readable `nikas.md` in the workspace root (best-effort) AND to a
 *     structured `context.globalState` snapshot (reliable restore path).
 *   - persistSessionMemory(): called from the provider when a compaction
 *     summary is produced, so it survives restarts.
 *   - injectPersistentMemory(): called from the provider at the start of a
 *     request; if the current conversation has saved memory for its key and it
 *     isn't already present, prepend it so a reopened session regains context.
 *
 * ALL additive + guarded: any failure is swallowed and the request path is
 * never altered or broken. VS Code passes no session id to the provider, so
 * memory is keyed off (workspaceKey + content-derived sessionKey).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { MemoryStore, deriveMemoryKey, type MemoryEntry, type MemorySnapshot } from './store.js';
import { getMemoryPersistence } from '../config.js';
import { log } from '../log.js';
import type { DeepSeekMessage } from '../api/types.js';

/** globalState key for the structured snapshot (reliable restore). */
const STATE_KEY = 'nikas.memory.v1';
/** Per-workspace human-readable memory file. */
const MEMORY_FILENAME = 'nikas.md';

/** Shared process-wide store (provider writes + manager renders). */
export const memoryStore = new MemoryStore();

/** Per-process set of already-injected (key@updatedAt) — avoid re-injecting every turn. */
const injectedThisProcess = new Set<string>();

/** Cheap deterministic string hash (FNV-1a-ish) — workspaceKey only. */
function simpleHash(input: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < input.length; i++) {
        const c = input.charCodeAt(i);
        h1 = (h1 ^ c) * 0x01000193;
        h2 = (h2 ^ c) * 0x85ebca6b;
    }
    return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).slice(0, 16);
}

/** Stable identity for the first workspace folder (or undefined if none). */
function currentWorkspaceKey(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? simpleHash(folder.uri.fsPath) : undefined;
}

/** Absolute path to the per-workspace nikas.md (or undefined if no folder). */
function memoryFilePath(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? path.join(folder.uri.fsPath, MEMORY_FILENAME) : undefined;
}

/** Best-effort write of the store to the workspace nikas.md. Never throws. */
async function writeNikasMd(): Promise<void> {
    const filePath = memoryFilePath();
    if (!filePath) return;
    try {
        const uri = vscode.Uri.file(filePath);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(memoryStore.renderMarkdown(), 'utf8'));
    } catch (err) {
        log.warn(`Persistent memory: failed to write ${MEMORY_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Best-effort read of the workspace nikas.md into the store (reload fallback). */
async function readNikasMd(): Promise<void> {
    const filePath = memoryFilePath();
    if (!filePath) return;
    try {
        const uri = vscode.Uri.file(filePath);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        const parsed = MemoryStore.parseMarkdown(text);
        if (parsed.length > 0) {
            memoryStore.hydrate({ entries: parsed });
        }
    } catch { /* no file / unreadable — not an error */ }
}

/**
 * Activate persistent memory: hydrate from globalState (or nikas.md fallback),
 * then wire persistence so future mutations are saved. Called once from
 * extension.ts. Returns the shared store. Never throws.
 */
export async function wireMemoryPersistence(context: vscode.ExtensionContext): Promise<MemoryStore> {
    try {
        const saved = context.globalState.get<MemorySnapshot>(STATE_KEY);
        if (saved?.entries?.length) {
            memoryStore.hydrate(saved);
        } else {
            await readNikasMd();
        }
    } catch { /* never break activation */ }

    memoryStore.setPersistence((snap) => {
        // Structured snapshot (reliable) + human-readable nikas.md (best-effort).
        void context.globalState.update(STATE_KEY, snap);
        void writeNikasMd();
    });

    return memoryStore;
}

/**
 * Save a session-memory summary for the current workspace + sessionKey.
 * Called from the provider after a compaction summary is produced. Best-effort
 * and additive — never throws, never affects the request.
 */
export async function persistSessionMemory(sessionKey: string, summary: string, source: 'compaction' | 'compact-command' = 'compaction'): Promise<void> {
    const wk = currentWorkspaceKey();
    if (!wk) return;
    try {
        memoryStore.upsert(wk, sessionKey, summary, source);
    } catch { /* additive */ }
}

/**
 * If the current conversation has saved persistent memory for (workspace,
 * sessionKey) and it is not already present in the message history, prepend a
 * user message re-injecting it. Returns the (possibly new) messages array.
 * Gated by nikas.memoryPersistence; best-effort + never throws.
 */
export function injectPersistentMemory(messages: DeepSeekMessage[], sessionKey: string): DeepSeekMessage[] {
    try {
        if (!getMemoryPersistence()) return messages;
        const wk = currentWorkspaceKey();
        if (!wk) return messages;

        // If the history already carries a session-memory block (compacted this
        // process), don't double-inject.
        const hasMemory = messages.some(m => memoryText(m).includes('[Session memory'));
        if (hasMemory) return messages;

        const entry = memoryStore.getEntry(wk, sessionKey);
        if (!entry) return messages;

        // Inject at most once per process per (key, version).
        const tag = `${entry.key}@${entry.updatedAt}`;
        if (injectedThisProcess.has(tag)) return messages;
        injectedThisProcess.add(tag);

        const block =
            `[Persisted session memory — from an earlier session of this conversation, ` +
            `restored by Nikas across restarts. Treat it as background context; it is NOT a ` +
            `new request. Rules and conventions apply ONLY to the exact file/function/feature ` +
            `they are attached to — do NOT extend them to unrelated code, and do NOT invent ` +
            `requirements that are not explicitly written here. The active task is in the ` +
            `messages below.]\n\n${entry.summary}`;

        return [{ role: 'user', content: block }, ...messages];
    } catch {
        return messages;
    }
}

/** Plain-text content of a DeepSeek message (local copy — no provider dep). */
function memoryText(msg: DeepSeekMessage): string {
    try {
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
            return msg.content
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && !!p.text)
                .map(p => p.text)
                .join(' ');
        }
    } catch { /* ignore */ }
    return '';
}

/** Exported for tests: reset the per-process injected-set (so re-injection can be exercised). */
export function _resetInjectedSetForTest(): void {
    injectedThisProcess.clear();
}

/** Exported for tests: parse helper passthrough. */
export function _deriveMemoryKey(workspaceKey: string, sessionKey: string): string {
    return deriveMemoryKey(workspaceKey, sessionKey);
}

/** Exported for diagnostics. */
export function describeMemoryState(): { file: string | undefined; entries: MemoryEntry[] } {
    return { file: memoryFilePath(), entries: memoryStore.entries() };
}
