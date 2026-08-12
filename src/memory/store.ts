/**
 * Nikas persistent session memory — durable, cross-restart memory store.
 *
 * PURE + vscode-free (unit-testable from plain Node, see test-memory.js).
 *
 * Background: the provider is stateless — VS Code re-sends the full original
 * history every turn and passes NO session/conversation id. Session memory
 * summaries (from context compaction, see src/context/compact.ts) therefore
 * live only in a process-local cache and are lost on restart. This store makes
 * them durable, keyed by (workspaceKey + sessionKey):
 *   - workspaceKey  — stable hash of the workspace folder path (a per-workspace
 *     nikas.md file is scoped to one workspace, but globalState is global, so
 *     the key keeps conversations of different workspaces apart).
 *   - sessionKey    — the provider's content-derived conversation key
 *     (getSessionKeyFromDeepSeek: FNV-1a of the first user turns), which is
 *     STABLE across restarts because it derives from the conversation text.
 *
 * So a conversation reopened after a VS Code restart maps to the same key and
 * can be re-injected (see injectPersistentMemory in manager.ts).
 *
 * Fully ADDITIVE: nothing here touches the request path — it only records
 * summaries produced elsewhere and (via the manager) optionally re-injects
 * them. Every method is guarded so it can never throw or break the chat path.
 */

export type MemorySource = 'compaction' | 'compact-command' | 'import';

export interface MemoryEntry {
    /** Combined identity: `${workspaceKey}|${sessionKey}`. */
    key: string;
    /** The session-memory summary text. */
    summary: string;
    /** Epoch ms of the last write. */
    updatedAt: number;
    /** Where the summary came from. */
    source: MemorySource;
}

export interface MemorySnapshot {
    entries: MemoryEntry[];
}

/** Upper bound on kept entries (LRU by updatedAt). */
const MAX_ENTRIES = 100;

/**
 * Combine a workspace identity + session key into a single stable memory key.
 */
export function deriveMemoryKey(workspaceKey: string, sessionKey: string): string {
    return `${workspaceKey}|${sessionKey}`;
}

export class MemoryStore {
    private _entries = new Map<string, MemoryEntry>();
    private _persist?: (snapshot: MemorySnapshot) => void;
    private _listeners = new Set<() => void>();

    /** Persistence hook — called after every mutation with a JSON-safe snapshot. */
    setPersistence(fn: (snapshot: MemorySnapshot) => void): void {
        this._persist = fn;
    }

    /** Subscribe to any change. */
    onDidChange(fn: () => void): () => void {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    private _fire(): void {
        for (const l of this._listeners) l();
        if (this._persist) {
            try { this._persist(this.snapshot()); } catch { /* persistence must never break requests */ }
        }
    }

    /** Upsert a summary for (workspaceKey, sessionKey). Never throws. */
    upsert(workspaceKey: string, sessionKey: string, summary: string, source: MemorySource = 'compaction'): void {
        try {
            const key = deriveMemoryKey(workspaceKey, sessionKey);
            this._entries.set(key, { key, summary: String(summary), updatedAt: Date.now(), source });
            if (this._entries.size > MAX_ENTRIES) {
                // Evict the least-recently-updated entry.
                let oldest: MemoryEntry | undefined;
                for (const e of this._entries.values()) {
                    if (!oldest || e.updatedAt < oldest.updatedAt) oldest = e;
                }
                if (oldest) this._entries.delete(oldest.key);
            }
            this._fire();
        } catch { /* accounting must never break the chat path */ }
    }

    /** Summary text for (workspaceKey, sessionKey), or undefined. */
    get(workspaceKey: string, sessionKey: string): string | undefined {
        return this._entries.get(deriveMemoryKey(workspaceKey, sessionKey))?.summary;
    }

    /** Full entry (with updatedAt/source) for a key, or undefined. */
    getEntry(workspaceKey: string, sessionKey: string): MemoryEntry | undefined {
        return this._entries.get(deriveMemoryKey(workspaceKey, sessionKey));
    }

    /** Remove one entry. */
    remove(workspaceKey: string, sessionKey: string): void {
        this._entries.delete(deriveMemoryKey(workspaceKey, sessionKey));
        this._fire();
    }

    /** All entries, oldest-updated first. */
    entries(): MemoryEntry[] {
        return [...this._entries.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    }

    get size(): number {
        return this._entries.size;
    }

    /** Replace all state from a persisted snapshot (idempotent). */
    hydrate(snapshot: Partial<MemorySnapshot> | undefined): void {
        if (!snapshot) return;
        try {
            this._entries.clear();
            if (Array.isArray(snapshot.entries)) {
                for (const e of snapshot.entries) {
                    if (e && typeof e.key === 'string' && typeof e.summary === 'string') {
                        this._entries.set(e.key, {
                            key: e.key,
                            summary: e.summary,
                            updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : Date.now(),
                            source: e.source ?? 'import',
                        });
                    }
                }
            }
        } catch { /* corrupt persisted state must never crash activation */ }
    }

    /** JSON-safe snapshot for persistence. */
    snapshot(): MemorySnapshot {
        return { entries: this.entries() };
    }

    /** Wipe all memory. */
    reset(): void {
        this._entries.clear();
        this._fire();
    }

    // ── Human-readable markdown (nikas.md) ──────────────────────────────
    /**
     * Render the store as a human-readable markdown document (the per-workspace
     * `nikas.md`). Round-trips with parseMarkdown().
     */
    renderMarkdown(): string {
        const lines = [
            '# Nikas Session Memory',
            '',
            'Auto-generated by the Nikas extension (persistent session memory).',
            'Summaries below are injected back into the matching conversation after a restart.',
            '',
        ];
        for (const e of this.entries()) {
            lines.push(`## Session ${e.key}`);
            lines.push(`- updated: ${new Date(e.updatedAt).toISOString()}`);
            lines.push(`- source: ${e.source}`);
            lines.push('');
            lines.push(e.summary);
            lines.push('');
        }
        return lines.join('\n');
    }

    /**
     * Parse a nikas.md document produced by renderMarkdown() back into entries.
     * Best-effort fallback for reload; the authoritative path is the structured
     * globalState snapshot. Never throws.
     */
    static parseMarkdown(text: string): MemoryEntry[] {
        const entries: MemoryEntry[] = [];
        try {
            const blocks = String(text).split(/\n## Session /);
            for (let i = 0; i < blocks.length; i++) {
                const block = blocks[i];
                // The first chunk (before any header) has no key — skip.
                if (i === 0) continue;
                const lines = block.split('\n');
                if (!lines.length) continue;
                const key = lines[0].trim();
                if (!key) continue;
                let updatedAt = 0;
                let source: MemorySource = 'import';
                const bodyLines: string[] = [];
                for (let j = 1; j < lines.length; j++) {
                    const line = lines[j];
                    const up = /^- updated: (.+)$/.exec(line);
                    const src = /^- source: (.+)$/.exec(line);
                    if (up) {
                        const t = Date.parse(up[1]);
                        if (!Number.isNaN(t)) updatedAt = t;
                        continue;
                    }
                    if (src) { source = (src[1] as MemorySource) ?? 'import'; continue; }
                    bodyLines.push(line);
                }
                const summary = bodyLines.join('\n').trim();
                if (key && summary) {
                    entries.push({ key, summary, updatedAt: updatedAt || Date.now(), source });
                }
            }
        } catch { /* ignore malformed input */ }
        return entries;
    }
}
