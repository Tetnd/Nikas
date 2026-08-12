/**
 * Health-check report builder (v0.7.86) — PURE + vscode-free.
 *
 * `buildHealthReport` renders the markdown diagnostics report from a plain
 * data object, so it's unit-testable from Node (see test-health.js). The
 * vscode-side gathering lives in commands/health.ts.
 */

export interface HealthReportInput {
    version: string;
    deepSeekKey: boolean;
    geminiKey: boolean;
    selectedModel: string;
    routerEnabled: boolean;
    routerMode: string;
    contextWindowTokens: number;
    maxTokens: number;
    thinkingEffort: string;
    toolBudget: boolean;
    toolBudgetTokens: number;
    pdfExtractCache: boolean;
    visionSource: string;
    visionModel: string | undefined;
    usage: {
        requests: number;
        totalTokens: number;
        estimatedCost: number;
        cacheHitTokens?: number;
        cacheMissTokens?: number;
    };
    patches: { found: boolean; applied: number; missing: string[]; bundlePath?: string };
    logPath: string;
    logSizeBytes: number;
}

/** Build the markdown health report (pure — unit-testable). */
export function buildHealthReport(input: HealthReportInput): string {
    const rows: string[] = [];
    rows.push(`# Nikas Health Check — v${input.version}`);
    rows.push('');

    rows.push('## Configuration');
    rows.push(`- **Model:** ${input.selectedModel} (max tokens ${input.maxTokens.toLocaleString()})`);
    rows.push(`- **Context window:** ${input.contextWindowTokens.toLocaleString()} tokens`);
    rows.push(`- **Thinking effort:** ${input.thinkingEffort}`);
    rows.push(`- **Model router:** ${input.routerEnabled ? `ON (${input.routerMode})` : 'OFF'}`);
    rows.push(`- **Tool-description budget:** ${input.toolBudget ? `ON (${input.toolBudgetTokens.toLocaleString()} tokens)` : 'OFF'}`);
    rows.push(`- **PDF extraction cache:** ${input.pdfExtractCache ? 'ON' : 'OFF'}`);
    rows.push(`- **Vision:** ${input.visionSource} (${input.visionModel || '—'})`);
    rows.push('');

    rows.push('## Credentials');
    rows.push(`- **DeepSeek API key:** ${input.deepSeekKey ? '✅ configured' : '❌ MISSING — run "Nikas: Input Deepseek userToken"'}`);
    rows.push(`- **Gemini API key:** ${input.geminiKey ? '✅ configured' : '— not set (only needed for Gemini vision)'}`);
    rows.push('');

    rows.push('## Usage & cost');
    rows.push(`- **Requests:** ${input.usage.requests}`);
    rows.push(`- **Total tokens:** ${input.usage.totalTokens.toLocaleString()}`);
    rows.push(`- **Estimated cost:** ~$${input.usage.estimatedCost.toFixed(4)}`);
    const cache = formatCacheRate(input.usage.cacheHitTokens, input.usage.cacheMissTokens);
    if (cache !== '—') {
        rows.push(`- **Prompt-cache hit rate:** ${cache} (${(input.usage.cacheHitTokens ?? 0).toLocaleString()} hit / ${(input.usage.cacheMissTokens ?? 0).toLocaleString()} miss tokens)`);
    }
    rows.push('');

    rows.push('## Copilot PDF patches');
    if (!input.patches.found) {
        rows.push('- ⚠ Copilot Chat bundle **not found** — patches cannot be checked.');
    } else if (input.patches.missing.length === 0) {
        rows.push(`- ✅ All ${input.patches.applied} patches applied.`);
    } else {
        rows.push(`- ⚠ ${input.patches.missing.length} patch(es) MISSING: ${input.patches.missing.join(', ')} — run "Nikas: Re-apply Copilot PDF Patches".`);
    }
    if (input.patches.bundlePath) {
        rows.push(`- Bundle: \`${input.patches.bundlePath}\``);
    }
    rows.push('');

    rows.push('## Logging');
    rows.push(`- **Log file:** \`${input.logPath}\``);
    rows.push(`- **Log size:** ${(input.logSizeBytes / 1024).toFixed(1)} KB`);
    rows.push('');
    rows.push('_Health check is read-only — nothing was modified._');
    return rows.join('\n');
}

/** Format a prompt-cache rate as a percent string (mirrors tracker helper). */
export function formatCacheRate(hit: number | undefined, miss: number | undefined): string {
    if (typeof hit !== 'number' || typeof miss !== 'number' || hit + miss <= 0) return '—';
    return `${Math.round((hit / (hit + miss)) * 100)}%`;
}
