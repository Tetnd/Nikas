/**
 * nikas.log report (v0.7.88, B-7) — aggregate real usage/cost figures from the
 * extension's own log file. PURE + vscode-free (unit-testable from Node).
 *
 * Parses the lines Nikas already writes:
 *   - `DeepSeek usage: prompt=250,482 (48% of 524,288 window), completion=383`
 *     (and the Responses variant `completion=...`)
 *   - `Context compacted: ~250,000 → ~40,000 real tokens (...)`
 *   - `[tool-budget] trimmed 10 description(s) (~4574 tokens freed; ...)`
 *   - `Model router: X → Y (reason)` and `Responses API: heavy ... → deepseek-v4-pro`
 *
 * The command reads nikas.log (via getLogFilePath) and renders a summary.
 */

export interface LogUsageTotals {
    requests: number;
    promptTokens: number;
    completionTokens: number;
}

export interface LogReport {
    usage: LogUsageTotals;
    /** Number of `DeepSeek usage:` events parsed. */
    compactionCount: number;
    /** Sum of tool-budget saved tokens across all requests. */
    toolBudgetSavedTokens: number;
    /** Number of tool-budget trim events. */
    toolBudgetTrimCount: number;
    /** Number of model-router / heavy-routing events. */
    routingEvents: number;
    /** Distinct models seen across `Sending DeepSeek ... model=` / Responses lines. */
    models: string[];
}

/** Extract a `key=value` (value may contain commas) from a log line. */
function kv(line: string, key: string): number | undefined {
    const m = new RegExp(`\\b${key}=([0-9,]+)`).exec(line);
    if (!m) return undefined;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
}

/** Parse nikas.log content into a compact summary (never throws). */
export function parseLogReport(text: string): LogReport {
    const report: LogReport = {
        usage: { requests: 0, promptTokens: 0, completionTokens: 0 },
        compactionCount: 0,
        toolBudgetSavedTokens: 0,
        toolBudgetTrimCount: 0,
        routingEvents: 0,
        models: [],
    };

    if (!text) return report;

    const modelSet = new Set<string>();
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        // Usage lines (chat + responses both log `prompt=`/`completion=`).
        if (/DeepSeek usage:/.test(line) && /prompt=/.test(line)) {
            const prompt = kv(line, 'prompt');
            const completion = kv(line, 'completion');
            if (typeof prompt === 'number') {
                report.usage.requests++;
                report.usage.promptTokens += prompt;
            }
            if (typeof completion === 'number') report.usage.completionTokens += completion;
        }

        // Context compaction.
        if (/Context compacted/.test(line)) {
            report.compactionCount++;
        }

        // Tool-description budget savings: `~4574 tokens freed`.
        if (/\[tool-budget\]/.test(line)) {
            report.toolBudgetTrimCount++;
            const m = /~([0-9,]+) tokens freed/.exec(line);
            if (m) {
                const n = Number(m[1].replace(/,/g, ''));
                if (Number.isFinite(n)) report.toolBudgetSavedTokens += n;
            }
        }

        // Model routing / heavy-pro events.
        if (/Model router:|heavy \w+ → deepseek-v4-pro/.test(line)) {
            report.routingEvents++;
        }

        // Model id capture.
        const model = /model=([a-zA-Z0-9_.-]+)/.exec(line);
        if (model) modelSet.add(model[1]);
    }

    report.models = [...modelSet];
    return report;
}
