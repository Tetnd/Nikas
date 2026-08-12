/**
 * Nikas usage & cost dashboard.
 *
 * Purely additive: reads the UsageTracker (fed by provider.ts at each
 * completed request) and renders a QuickPick summary. Nothing here modifies
 * the request path. Persistence is wired to context.globalState in
 * extension.ts via wireUsagePersistence().
 */
import * as vscode from 'vscode';
import { usageTracker, formatTokens, formatCost, getCurrentSessionKey, type UsageAggregate, type UsageSnapshot } from '../usage/tracker.js';

const STATE_KEY = 'nikas.usageTracker.v1';

function fmtAgg(a: UsageAggregate): string {
    return [
        `${a.requests} request${a.requests === 1 ? '' : 's'}`,
        `${formatTokens(a.promptTokens)} in`,
        `${formatTokens(a.completionTokens)} out`,
        `${formatTokens(a.totalTokens)} total`,
        `~${formatCost(a.estimatedCost)}`,
    ].join(' · ');
}

function line(t: string): vscode.QuickPickItem {
    return { label: t };
}

/** Open the usage dashboard QuickPick (recomputed on every open). */
export async function showUsage(): Promise<void> {
    const s = usageTracker.snapshot();

    const providerItems: vscode.QuickPickItem[] = Object.keys(s.byProvider)
        .sort((a, b) => (s.byProvider[b]?.totalTokens ?? 0) - (s.byProvider[a]?.totalTokens ?? 0))
        .map(p => {
            const a = s.byProvider[p];
            return {
                label: `$(circuit-board) ${p}`,
                description: fmtAgg(a),
                detail: `model: ${providerModelLabel(p, s)}`,
            };
        });

    const sessionItems: vscode.QuickPickItem[] = Object.keys(s.bySession)
        .sort((a, b) => (s.bySession[b]?.totalTokens ?? 0) - (s.bySession[a]?.totalTokens ?? 0))
        .slice(0, 8)
        .map(k => {
            const a = s.bySession[k];
            const label = s.sessionLabels[k] || `session ${k}`;
            return {
                label: `$(comment-discussion) ${truncate(label, 48)}`,
                description: fmtAgg(a),
                detail: `key: ${k}`,
            };
        });

    const current = usageTracker.session(getCurrentSessionKey());
    const items: vscode.QuickPickItem[] = [
        {
            label: `$(dashboard) Nikas Usage & Cost`,
            description: `all time`,
            detail: fmtAgg(s.total),
        },
        {
            label: `$(pulse) This session`,
            description: `current conversation`,
            detail: fmtAgg(current),
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(circuit-board) By provider', kind: vscode.QuickPickItemKind.Separator },
        ...(providerItems.length ? providerItems : [line('  — no requests recorded yet —')]),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(comment-discussion) Top sessions', kind: vscode.QuickPickItemKind.Separator },
        ...(sessionItems.length ? sessionItems : [line('  — no sessions recorded yet —')]),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        {
            label: '$(copy) Copy summary to clipboard',
            description: 'Markdown report you can paste anywhere',
        },
        {
            label: '$(trash) Reset usage stats',
            description: 'Clear all recorded tokens and cost',
        },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Nikas: Usage & Cost',
        placeHolder: 'Select an item for details',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!pick) return;

    if (pick.label.includes('Copy summary')) {
        const md = buildMarkdownReport(s);
        await vscode.env.clipboard.writeText(md);
        vscode.window.showInformationMessage('Nikas usage summary copied to clipboard.');
        return;
    }
    if (pick.label.includes('Reset usage stats')) {
        const choice = await vscode.window.showWarningMessage(
            'Reset all Nikas usage & cost stats? This cannot be undone.',
            { modal: true },
            'Reset'
        );
        if (choice === 'Reset') {
            usageTracker.reset();
            vscode.window.showInformationMessage('Nikas usage stats reset.');
        }
        return;
    }
    if (pick.detail && (providerItems.includes(pick) || sessionItems.includes(pick))) {
        await vscode.window.showInformationMessage(pick.detail, { modal: false });
    }
}

/** Reset all recorded usage (command entry, same guard as the menu action). */
export async function resetUsage(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
        'Reset all Nikas usage & cost stats? This cannot be undone.',
        { modal: true },
        'Reset'
    );
    if (choice === 'Reset') {
        usageTracker.reset();
        vscode.window.showInformationMessage('Nikas usage stats reset.');
    }
}

/** Wire persistence to globalState + register a status bar item. */
export function wireUsagePersistence(context: vscode.ExtensionContext): vscode.StatusBarItem {
    // Load persisted state (if any) into the tracker.
    try {
        const raw = context.globalState.get<Partial<UsageSnapshot>>(STATE_KEY);
        usageTracker.hydrate(raw);
    } catch { /* non-fatal */ }

    usageTracker.setPersistence((snap) => {
        try { void context.globalState.update(STATE_KEY, snap); } catch { /* non-fatal */ }
    });

    const item = createUsageStatusBarItem();
    context.subscriptions.push(item);

    // Refresh the status bar whenever a request is recorded.
    const update = () => updateUsageStatusBar(item);
    update();
    context.subscriptions.push({ dispose: usageTracker.onDidChange(update) });

    return item;
}

/** Right-aligned status bar item showing the current session's tokens/cost. */
export function createUsageStatusBarItem(): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    item.command = 'nikas.usage';
    item.tooltip = 'Nikas: usage & cost — click for details';
    return item;
}

/** Refresh the status bar text from the current session aggregate. */
export function updateUsageStatusBar(item: vscode.StatusBarItem): void {
    const a = usageTracker.session(getCurrentSessionKey());
    if (a.requests === 0) {
        item.hide();
        return;
    }
    item.text = `$(graph-line) ${formatTokens(a.totalTokens)} · ${formatCost(a.estimatedCost)}`;
    item.tooltip = `Nikas usage (this session)\n${fmtAgg(a)}\nClick for the full dashboard.`;
    item.show();
}

function providerModelLabel(p: string, s: UsageSnapshot): string {
    const model = s.recent.find(r => r.provider === p)?.model;
    return model ?? '—';
}

function truncate(text: string, n: number): string {
    return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/** Markdown report for clipboard export. */
export function buildMarkdownReport(s: UsageSnapshot): string {
    const rows: string[] = [];
    rows.push('# Nikas Usage & Cost');
    rows.push('');
    rows.push(`- **Requests:** ${s.total.requests}`);
    rows.push(`- **Prompt tokens:** ${s.total.promptTokens.toLocaleString()}`);
    rows.push(`- **Completion tokens:** ${s.total.completionTokens.toLocaleString()}`);
    rows.push(`- **Total tokens:** ${s.total.totalTokens.toLocaleString()}`);
    rows.push(`- **Estimated cost:** ~${formatCost(s.total.estimatedCost)}`);
    rows.push('');
    rows.push('## By provider');
    rows.push('');
    rows.push('| Provider | Requests | Prompt | Completion | Total | Est. cost |');
    rows.push('|---|---|---|---|---|---|');
    for (const p of Object.keys(s.byProvider).sort()) {
        const a = s.byProvider[p];
        rows.push(`| ${p} | ${a.requests} | ${a.promptTokens.toLocaleString()} | ${a.completionTokens.toLocaleString()} | ${a.totalTokens.toLocaleString()} | ~${formatCost(a.estimatedCost)} |`);
    }
    rows.push('');
    rows.push('## Top sessions');
    rows.push('');
    rows.push('| Session | Requests | Total tokens | Est. cost |');
    rows.push('|---|---|---|---|');
    for (const k of Object.keys(s.bySession).sort((a, b) => (s.bySession[b]?.totalTokens ?? 0) - (s.bySession[a]?.totalTokens ?? 0)).slice(0, 10)) {
        const a = s.bySession[k];
        const label = s.sessionLabels[k] || k;
        rows.push(`| ${truncate(label, 60)} | ${a.requests} | ${a.totalTokens.toLocaleString()} | ~${formatCost(a.estimatedCost)} |`);
    }
    rows.push('');
    rows.push('_Estimated cost uses approximate per-provider pricing._');
    return rows.join('\n');
}
