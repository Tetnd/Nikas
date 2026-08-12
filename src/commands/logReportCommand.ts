/**
 * Nikas: Log Report command (v0.7.88, B-7) — summarize real usage from
 * nikas.log. Reads the current log (+ rotated `.1`), aggregates the usage /
 * compaction / tool-budget / routing lines, shows a QuickPick. Read-only.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { getLogFilePath } from '../log.js';
import { parseLogReport } from './logReport.js';
import { formatTokens } from '../usage/tracker.js';

/** Read nikas.log (+ .1) and parse a report. Never throws. */
export function collectLogReport() {
    let text = '';
    try { text += fs.readFileSync(getLogFilePath(), 'utf8'); } catch { /* no log yet */ }
    try {
        const rotated = `${getLogFilePath()}.1`;
        if (fs.existsSync(rotated)) text += '\n' + fs.readFileSync(rotated, 'utf8');
    } catch { /* non-fatal */ }
    return parseLogReport(text);
}

/** Show the log report as a QuickPick summary. */
export async function runLogReport(): Promise<void> {
    const r = collectLogReport();
    const items: vscode.QuickPickItem[] = [
        { label: '$(dashboard) nikas.log usage (parsed)', description: 'aggregated from the log lines' },
        { label: '$(circuit-board) Requests', description: `${r.usage.requests}` },
        { label: '$(symbol-array) Prompt tokens', description: formatTokens(r.usage.promptTokens) },
        { label: '$(symbol-array) Completion tokens', description: formatTokens(r.usage.completionTokens) },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(sync) Context compaction events', description: `${r.compactionCount}` },
        { label: '$(filter) Tool-budget saved', description: `${r.toolBudgetTrimCount} trim(s) · ~${formatTokens(r.toolBudgetSavedTokens)} tokens` },
        { label: '$(arrow-swap) Routing events', description: `${r.routingEvents}` },
        { label: '$(symbol-method) Models seen', description: r.models.length ? r.models.join(', ') : '—' },
        { label: '$(tag) Raw log path', description: getLogFilePath() },
    ];
    await vscode.window.showQuickPick(items, {
        title: 'Nikas: Log Report',
        placeHolder: 'Aggregated from the current nikas.log (+ rotated .1 file)',
        matchOnDescription: true,
    });
}
