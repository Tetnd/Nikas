/**
 * Nikas: Health Check (v0.7.86) — one-shot diagnostics command.
 *
 * Gathers a read-only snapshot: extension version, API keys, model + router
 * configuration, context settings, usage totals + prompt-cache rate, PDF
 * patch health, and the nikas.log path/size. Renders it into a dedicated
 * "Nikas Health" output channel and a QuickPick summary.
 *
 * Purely diagnostic — never mutates anything.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { SecretStore } from '../secrets.js';
import {
    getSelectedModel,
    getContextWindowTokens,
    getThinkingEffort,
    getModelRouter,
    getModelRouterMode,
    getToolBudget,
    getToolBudgetTokens,
    getPdfExtractCache,
    getVisionSource,
    getVisionModelKey,
    getMaxTokens,
    getCopilotMaxFileSizeMB,
} from '../config.js';
import { getLogFilePath } from '../log.js';
import { usageTracker, formatTokens, formatCost } from '../usage/tracker.js';
import { locateCopilotBundle, healthCheck } from '../pdf/manager.js';
import { buildPatches } from '../pdf/patches.js';
import { buildHealthReport, formatCacheRate } from './healthReport.js';

/** Run the health check and surface it (output channel + QuickPick). */
export async function runHealthCheck(context: vscode.ExtensionContext): Promise<void> {
    const secrets = new SecretStore(context.secrets);
    let deepSeekKey = false;
    let geminiKey = false;
    try {
        deepSeekKey = !!(await secrets.getDeepSeekApiKey());
        geminiKey = !!(await secrets.getGeminiApiKey());
    } catch { /* non-fatal */ }

    const s = usageTracker.snapshot();

    // PDF patch health (read-only engine; never applies anything).
    let patchesFound = false;
    let appliedCount = 0;
    let missing: string[] = [];
    let bundlePath: string | undefined;
    try {
        bundlePath = locateCopilotBundle();
        if (bundlePath) {
            const raw = fs.readFileSync(bundlePath, 'utf-8');
            const health = healthCheck(raw, buildPatches({ maxFileSizeMB: getCopilotMaxFileSizeMB() }));
            appliedCount = health.filter(h => h.applied).length;
            missing = health.filter(h => !h.applied).map(h => h.id);
            patchesFound = true;
        }
    } catch { /* non-fatal — report as not found */ }

    let logPath = '';
    let logSizeBytes = 0;
    try {
        logPath = getLogFilePath();
        logSizeBytes = fs.statSync(logPath).size;
    } catch { /* log may not exist yet */ }

    const report = buildHealthReport({
        version: String(context.extension.packageJSON?.version ?? '?'),
        deepSeekKey,
        geminiKey,
        selectedModel: getSelectedModel(),
        routerEnabled: getModelRouter(),
        routerMode: getModelRouterMode(),
        contextWindowTokens: getContextWindowTokens(),
        maxTokens: getMaxTokens(),
        thinkingEffort: getThinkingEffort(),
        toolBudget: getToolBudget(),
        toolBudgetTokens: getToolBudgetTokens(),
        pdfExtractCache: getPdfExtractCache(),
        visionSource: getVisionSource(),
        visionModel: getVisionModelKey(),
        usage: {
            requests: s.total.requests,
            totalTokens: s.total.totalTokens,
            estimatedCost: s.total.estimatedCost,
            cacheHitTokens: s.total.cacheHitTokens,
            cacheMissTokens: s.total.cacheMissTokens,
        },
        patches: { found: patchesFound, applied: appliedCount, missing, bundlePath },
        logPath,
        logSizeBytes,
    });

    const channel = vscode.window.createOutputChannel('Nikas Health');
    channel.clear();
    channel.appendLine(report);
    channel.show(true);

    const items: vscode.QuickPickItem[] = [
        {
            label: `${deepSeekKey ? '$(check)' : '$(warning)'} DeepSeek API key`,
            description: deepSeekKey ? 'configured' : 'MISSING',
        },
        {
            label: `$(circuit-board) Model`,
            description: `${getSelectedModel()} · ${getModelRouter() ? `router ${getModelRouterMode()}` : 'router off'}`,
        },
        {
            label: '$(shield) Copilot PDF patches',
            description: patchesFound
                ? (missing.length === 0 ? `${appliedCount}/${appliedCount} applied` : `${missing.length} missing`)
                : 'bundle not found',
        },
        {
            label: '$(graph-line) Usage',
            description: `${s.total.requests} requests · ${formatTokens(s.total.totalTokens)} · ~${formatCost(s.total.estimatedCost)}`,
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(output) Full report in the "Nikas Health" output channel' },
    ];
    await vscode.window.showQuickPick(items, {
        title: 'Nikas: Health Check',
        placeHolder: 'Summary — full report in the "Nikas Health" output channel',
        matchOnDescription: true,
    });
}
