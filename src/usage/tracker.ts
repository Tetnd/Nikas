/**
 * Nikas usage tracker — per-request token + estimated-cost accounting.
 *
 * PURE + vscode-free (unit-testable from plain Node, see test-usage.js).
 * Keeps in-memory aggregates (total / by-provider / by-session / recent) and
 * delegates persistence to an injected callback (extension.ts wires
 * context.globalState). Fully ADDITIVE: nothing here touches the request
 * path — it only OBSERVES completed requests.
 */

export type UsageProvider =
    | 'deepseek'
    | 'deepseek-responses'
    | 'gemini'
    | 'gemma4'
    | 'vision'
    | 'unknown';

export interface UsageRecord {
    provider: UsageProvider;
    /** Model id as seen by the caller (e.g. deepseek-v4-flash, gemini-2.5-flash). */
    model: string;
    promptTokens: number;
    completionTokens: number;
    /** Epoch ms when the request completed. */
    timestamp: number;
    /** Wall-clock duration of the request in ms (v0.7.85 latency telemetry). */
    latencyMs?: number;
    /** Time to first text/tool chunk in ms (v0.7.86 TTFT telemetry). */
    ttftMs?: number;
    /** DeepSeek prompt-cache hit tokens (v0.7.86 cache telemetry). */
    cacheHitTokens?: number;
    /** DeepSeek prompt-cache miss tokens (v0.7.86 cache telemetry). */
    cacheMissTokens?: number;
    /** Content-derived per-conversation key (optional — empty for unkeyed calls). */
    sessionKey?: string;
    /** Human-readable first-user-message preview, for the per-session view. */
    sessionLabel?: string;
}

export interface UsageAggregate {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Estimated USD cost (per-provider pricing applied). */
    estimatedCost: number;
    lastUsed: number;
    /** DeepSeek prompt-cache hit tokens (v0.7.86). */
    cacheHitTokens?: number;
    /** DeepSeek prompt-cache miss tokens (v0.7.86). */
    cacheMissTokens?: number;
}

export interface UsageSnapshot {
    total: UsageAggregate;
    byProvider: Record<string, UsageAggregate>;
    bySession: Record<string, UsageAggregate>;
    /** Most recent records, newest first, capped. */
    recent: UsageRecord[];
    /** First-seen human label per session key. */
    sessionLabels: Record<string, string>;
}

/** Per-1M-token USD pricing (approximate defaults — overridable via setPricing). */
export const DEFAULT_PRICING: Record<UsageProvider, { inputPerM: number; outputPerM: number }> = {
    // DeepSeek V4 / chat-completions + responses (approximate, cache-miss input).
    deepseek: { inputPerM: 0.27, outputPerM: 1.1 },
    'deepseek-responses': { inputPerM: 0.27, outputPerM: 1.1 },
    // Gemini 2.5 Flash direct API.
    gemini: { inputPerM: 0.3, outputPerM: 2.5 },
    // Local (Ollama) — free.
    gemma4: { inputPerM: 0, outputPerM: 0 },
    // Gemini vision description sub-calls.
    vision: { inputPerM: 0.3, outputPerM: 2.5 },
    unknown: { inputPerM: 0, outputPerM: 0 },
};

const RECENT_CAP = 200;
const SESSION_CAP = 50;

function emptyAggregate(): UsageAggregate {
    return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0, lastUsed: 0 };
}

// Master on/off switch (settings: nikas.usageTracking). Off = record() is a
// no-op, so the request path is untouched even though the calls remain in the
// handlers (gating here keeps provider code free of config reads).
let _trackingEnabled = true;
export function setUsageTrackingEnabled(enabled: boolean): void {
    _trackingEnabled = enabled;
}
export function isUsageTrackingEnabled(): boolean {
    return _trackingEnabled;
}

export class UsageTracker {
    private _total = emptyAggregate();
    private _byProvider: Record<string, UsageAggregate> = {};
    private _bySession: Record<string, UsageAggregate> = {};
    private _recent: UsageRecord[] = [];
    private _sessionLabels: Record<string, string> = {};
    private _pricing: Record<UsageProvider, { inputPerM: number; outputPerM: number }> = DEFAULT_PRICING;
    private _persist?: (snapshot: UsageSnapshot) => void;
    private _listeners = new Set<() => void>();

    /** Override per-provider pricing (used by tests; defaults are sane). */
    setPricing(p: Partial<Record<UsageProvider, { inputPerM: number; outputPerM: number }>>): void {
        this._pricing = { ...this._pricing, ...p };
    }

    /** Persistence hook — called after every mutation with a JSON-safe snapshot. */
    setPersistence(fn: (snapshot: UsageSnapshot) => void): void {
        this._persist = fn;
    }

    /** Subscribe to any change (used by the status bar to refresh). */
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

    private static _agg(a: UsageAggregate | undefined): UsageAggregate {
        if (!a) return emptyAggregate();
        return a;
    }

    /** Record one completed request. Safe to call from any handler; never throws. */
    record(rec: UsageRecord): void {
        if (!_trackingEnabled) return;
        try {
            const provider = rec.provider;
            const price = this._pricing[provider] ?? this._pricing.unknown;
            const cost = (rec.promptTokens / 1_000_000) * price.inputPerM
                + (rec.completionTokens / 1_000_000) * price.outputPerM;

            const add = (agg: UsageAggregate | undefined): UsageAggregate => {
                const a = agg ?? emptyAggregate();
                a.requests += 1;
                a.promptTokens += rec.promptTokens;
                a.completionTokens += rec.completionTokens;
                a.totalTokens += rec.promptTokens + rec.completionTokens;
                a.estimatedCost += cost;
                a.lastUsed = rec.timestamp;
                if (typeof rec.cacheHitTokens === 'number') {
                    a.cacheHitTokens = (a.cacheHitTokens ?? 0) + rec.cacheHitTokens;
                }
                if (typeof rec.cacheMissTokens === 'number') {
                    a.cacheMissTokens = (a.cacheMissTokens ?? 0) + rec.cacheMissTokens;
                }
                return a;
            };

            this._total = add(this._total);
            this._byProvider[provider] = add(this._byProvider[provider]);

            if (rec.sessionKey) {
                this._bySession[rec.sessionKey] = add(this._bySession[rec.sessionKey]);
                if (rec.sessionLabel && !this._sessionLabels[rec.sessionKey]) {
                    this._sessionLabels[rec.sessionKey] = rec.sessionLabel;
                }
            }

            this._recent.unshift(rec);
            if (this._recent.length > RECENT_CAP) this._recent.length = RECENT_CAP;

            // Bound the session map so unbounded sessions can't leak memory.
            const keys = Object.keys(this._bySession);
            if (keys.length > SESSION_CAP) {
                keys.sort((x, y) => (this._bySession[x]?.lastUsed ?? 0) - (this._bySession[y]?.lastUsed ?? 0));
                for (const k of keys.slice(0, keys.length - SESSION_CAP)) {
                    delete this._bySession[k];
                    delete this._sessionLabels[k];
                }
            }

            this._fire();
        } catch {
            // Accounting must never break the chat path.
        }
    }

    /** Replace all state from a previously persisted snapshot (idempotent). */
    hydrate(snapshot: Partial<UsageSnapshot> | undefined): void {
        if (!snapshot) return;
        try {
            this._total = UsageTracker._agg(snapshot.total);
            this._byProvider = snapshot.byProvider ?? {};
            this._bySession = snapshot.bySession ?? {};
            this._sessionLabels = snapshot.sessionLabels ?? {};
            this._recent = Array.isArray(snapshot.recent) ? snapshot.recent.slice(0, RECENT_CAP) : [];
        } catch {
            // Corrupt persisted state must never crash activation.
        }
    }

    /** Full JSON-safe snapshot for persistence. */
    snapshot(): UsageSnapshot {
        return {
            total: { ...this._total },
            byProvider: { ...this._byProvider },
            bySession: { ...this._bySession },
            recent: this._recent.map(r => ({ ...r })),
            sessionLabels: { ...this._sessionLabels },
        };
    }

    /** Per-session aggregate (for the status bar + /cost). */
    session(sessionKey?: string): UsageAggregate {
        return sessionKey ? UsageTracker._agg(this._bySession[sessionKey]) : emptyAggregate();
    }

    /** Wipe all recorded usage (user-invoked reset). */
    reset(): void {
        this._total = emptyAggregate();
        this._byProvider = {};
        this._bySession = {};
        this._recent = [];
        this._sessionLabels = {};
        this._fire();
    }

    get total(): UsageAggregate { return this._total; }
    get byProvider(): Record<string, UsageAggregate> { return this._byProvider; }
    get bySession(): Record<string, UsageAggregate> { return this._bySession; }
    get recent(): UsageRecord[] { return this._recent; }
    get sessionLabels(): Record<string, string> { return this._sessionLabels; }

    /** Most recent recorded request (or undefined when nothing recorded yet). */
    lastRequest(): UsageRecord | undefined {
        return this._recent.length > 0 ? this._recent[0] : undefined;
    }
}

/** Format a token count compactly: 12345 → "12.3k". */
export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

/** Format USD cost: "$0.0042" / "$1.23". */
export function formatCost(cost: number): string {
    if (cost >= 1) return `$${cost.toFixed(2)}`;
    if (cost >= 0.01) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(4)}`;
}

/** Format a wall-clock duration: 812 → "0.8s", 3200 → "3.2s", 65_000 → "1m 5s". */
export function formatLatency(ms: number | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
}

/**
 * Format a DeepSeek prompt-cache rate as a percent string (v0.7.86).
 * Returns '—' when there is no cache data.
 */
export function formatCacheRate(hit: number | undefined, miss: number | undefined): string {
    if (typeof hit !== 'number' || typeof miss !== 'number' || hit + miss <= 0) return '—';
    return `${Math.round((hit / (hit + miss)) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Current-session tracking (for the status bar + /cost)
// ---------------------------------------------------------------------------
// The provider derives a per-conversation key in-band (see
// getSessionKeyFromDeepSeek in provider.ts); it reports it here so the UI can
// show "this session" without re-deriving it.
let _lastSessionKey: string | undefined;
export function setCurrentSessionKey(key: string | undefined): void {
    _lastSessionKey = key;
}
export function getCurrentSessionKey(): string | undefined {
    return _lastSessionKey;
}

// ---------------------------------------------------------------------------
// Shared process-wide tracker instance
// ---------------------------------------------------------------------------
// Both provider.ts (records) and commands/usage.ts (renders) use this one
// instance; persistence is wired by extension.ts via setPersistence().
export const usageTracker = new UsageTracker();
