/**
 * Copilot Chat PDF patch manager.
 *
 * Applies (and keeps applied) the Copilot Chat PDF patches. Every Copilot
 * Chat / VS Code update overwrites the bundled `extension.js` and wipes the
 * patches, so this manager:
 *
 *   1. Locates the Copilot Chat bundle (handles VS Code build-hash moves).
 *   2. Runs a marker-based health check for all 8 patches.
 *   3. Backs up the bundle, applies any missing patches (exact + regex
 *      fallback), writes, then re-verifies.
 *   4. Stores a SHA-256 of the patched bundle so unchanged bundles are
 *      skipped instantly on subsequent runs.
 *
 * The extension triggers this on activation, on extension changes (catches
 * Copilot Chat updates), on a periodic timer, and via explicit commands.
 *
 * Safety: we never touch the bundle unless a patch's exact find string (or a
 * scoped regex) matches, and we always keep a timestamped backup first.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { log } from '../log.js';
import { buildPatches, type PatchDefinition } from './patches.js';
import {
    getAutoPatchEnabled,
    getCopilotMaxFileSizeMB,
    getPatchBackupRetention,
} from '../config.js';

/** globalState keys — detect "Copilot updated since we last patched". */
const STATE_BUNDLE_HASH = 'nikas.copilotBundleHash';
const STATE_ALL_APPLIED = 'nikas.copilotPatchesAllApplied';

// ---------------------------------------------------------------------------
// Logging (own output channel so patch activity is easy to find)
// ---------------------------------------------------------------------------

let _output: vscode.OutputChannel | undefined;
function output(): vscode.OutputChannel {
    if (!_output) {
        _output = vscode.window.createOutputChannel('Nikas PDF Patcher');
    }
    return _output;
}

function info(msg: string): void {
    output().appendLine(`[${new Date().toISOString()}] ${msg}`);
    log.info(`[CopilotPatcher] ${msg}`);
}
function warn(msg: string): void {
    output().appendLine(`[${new Date().toISOString()}] WARN ${msg}`);
    log.warn(`[CopilotPatcher] ${msg}`);
}
function err(msg: string, e?: unknown): void {
    output().appendLine(`[${new Date().toISOString()}] ERROR ${msg}`);
    log.error(`[CopilotPatcher] ${msg}`, e);
}

// ---------------------------------------------------------------------------
// Locating the bundle
// ---------------------------------------------------------------------------

/**
 * Find the installed Copilot Chat `dist/extension.js`.
 *
 * Preference order:
 *   1. Bundled under the current VS Code app root (handles build-hash moves
 *      automatically because `vscode.env.appRoot` always points at the
 *      current install).
 *   2. Any `copilot*` / `github.copilot-chat*` folder under the app root's
 *      extensions dir.
 *   3. User-installed Copilot Chat under `~/.vscode/extensions`.
 */
export function locateCopilotBundle(): string | undefined {
    const candidates: string[] = [];

    const appRoot = vscode.env.appRoot;
    if (appRoot) {
        candidates.push(
            path.join(appRoot, 'extensions', 'copilot', 'dist', 'extension.js'),
            path.join(appRoot, 'extensions', 'github.copilot-chat', 'dist', 'extension.js'),
            path.join(appRoot, 'extensions', 'github.copilot-chat-beta', 'dist', 'extension.js'),
        );
        candidates.push(...findBundleUnder(path.join(appRoot, 'extensions'), ['copilot', 'github.copilot-chat']));
    }

    const userExtRoot = process.env.VSCODE_EXTENSIONS || path.join(os.homedir(), '.vscode', 'extensions');
    candidates.push(...findBundleUnder(userExtRoot, ['github.copilot-chat', 'copilot']));

    return candidates.find(c => {
        try { return fs.existsSync(c); } catch { return false; }
    });
}

/** Look in `<root>/<name>*` folders for `<name>/dist/extension.js`. */
function findBundleUnder(root: string, prefixes: string[]): string[] {
    const found: string[] = [];
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => e.name);
    } catch {
        return found;
    }
    for (const name of entries) {
        if (prefixes.some(p => name === p || name.startsWith(p + '-'))) {
            const bundle = path.join(root, name, 'dist', 'extension.js');
            try {
                if (fs.existsSync(bundle)) found.push(bundle);
            } catch { /* ignore */ }
        }
    }
    return found;
}

// ---------------------------------------------------------------------------
// Health check / applying
// ---------------------------------------------------------------------------

export interface PatchHealth {
    id: string;
    description: string;
    applied: boolean;
}

export function healthCheck(content: string, patches: PatchDefinition[]): PatchHealth[] {
    return patches.map(p => ({
        id: p.id,
        description: p.description,
        applied: p.appliedMarkers.some(m => content.includes(m)),
    }));
}

export interface ApplyOutcome {
    content: string;
    appliedIds: string[];
    failedIds: string[];
    failedReasons: Record<string, string>;
}

/** Apply all missing patches to `content`. Returns new content + outcomes. */
export function applyMissing(content: string, missing: PatchDefinition[]): ApplyOutcome {
    let working = content;
    const appliedIds: string[] = [];
    const failedIds: string[] = [];
    const failedReasons: Record<string, string> = {};

    for (const patch of missing) {
        const res = applyOne(working, patch);
        if (res.success) {
            working = res.content;
            appliedIds.push(patch.id);
            info(`Applied ${patch.id} — ${patch.description}`);
        } else {
            failedIds.push(patch.id);
            failedReasons[patch.id] = res.reason;
            warn(`Could NOT auto-apply ${patch.id} (${patch.description}): ${res.reason}`);
        }
    }

    return { content: working, appliedIds, failedIds, failedReasons };
}

function applyOne(content: string, patch: PatchDefinition): { success: boolean; content: string; reason: string } {
    // 1) Exact replacements (preferred — minified files must be edited surgically).
    for (const r of patch.replacements) {
        if (content.includes(r.find)) {
            return { success: true, content: content.replace(r.find, r.replace), reason: '' };
        }
    }

    // 2) Regex fallbacks (for version drift in minified symbol names).
    for (const fb of patch.regexFallbacks ?? []) {
        const re = new RegExp(fb.pattern.source, fb.pattern.flags);
        if (re.test(content)) {
            const replaced = typeof fb.replacement === 'function'
                ? content.replace(re, fb.replacement)
                : content.replace(re, fb.replacement);
            if (replaced !== content) {
                return { success: true, content: replaced, reason: '' };
            }
        }
    }

    return {
        success: false,
        content,
        reason: 'No matching snippet found. The Copilot bundle structure likely changed — this patch needs a manual update (see README re-patch recipe).',
    };
}

// ---------------------------------------------------------------------------
// Backup helpers
// ---------------------------------------------------------------------------

export function backupBundle(bundlePath: string): string | undefined {
    try {
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..+/, '');
        const backup = `${bundlePath}.bak-${stamp}`;
        fs.copyFileSync(bundlePath, backup);
        info(`Backed up bundle → ${backup}`);
        return backup;
    } catch (e) {
        err(`Failed to back up bundle before patching`, e);
        return undefined;
    }
}

export function pruneBackups(bundlePath: string, keep: number): void {
    try {
        const dir = path.dirname(bundlePath);
        const base = path.basename(bundlePath);
        const backups = fs.readdirSync(dir)
            .filter(f => f.startsWith(base + '.bak-'))
            .sort();
        while (backups.length > keep) {
            const oldest = backups.shift()!;
            try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
}

function sha256(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// The patch cycle
// ---------------------------------------------------------------------------

export interface PatchCycleReport {
    bundlePath?: string;
    found: boolean;
    /** True when no patching was needed (all markers present, or hash unchanged). */
    alreadyPatched: boolean;
    /** True when the run was skipped because the stored hash matched. */
    skippedByHash: boolean;
    appliedIds: string[];
    failedIds: string[];
    failedReasons: Record<string, string>;
    backupPath?: string;
    error?: string;
    disabled?: boolean;
}

let cycleInProgress = false;

/**
 * Run one full patch cycle: locate → health check → backup → apply → write →
 * verify → record state. Safe to call repeatedly; cheap when nothing changed.
 *
 * @param opts.force  Skip the hash shortcut and always health-check + apply.
 */
export async function runPatchCycle(
    context: vscode.ExtensionContext,
    opts?: { force?: boolean },
): Promise<PatchCycleReport> {
    const enabled = getAutoPatchEnabled();
    if (!enabled && !opts?.force) {
        return { found: false, alreadyPatched: true, skippedByHash: false, appliedIds: [], failedIds: [], failedReasons: {}, disabled: true };
    }
    if (cycleInProgress) {
        return { found: false, alreadyPatched: true, skippedByHash: true, appliedIds: [], failedIds: [], failedReasons: {} };
    }
    cycleInProgress = true;

    const base: PatchCycleReport = {
        found: false,
        alreadyPatched: false,
        skippedByHash: false,
        appliedIds: [],
        failedIds: [],
        failedReasons: {},
    };

    try {
        const bundlePath = locateCopilotBundle();
        if (!bundlePath) {
            warn('Could not locate the Copilot Chat bundle (extensions/copilot/dist/extension.js).');
            return { ...base, error: 'not-found' };
        }
        base.bundlePath = bundlePath;
        base.found = true;

        const patches = buildPatches({ maxFileSizeMB: getCopilotMaxFileSizeMB() });

        let raw: string;
        try {
            raw = fs.readFileSync(bundlePath, 'utf-8');
        } catch (e) {
            err(`Failed to read bundle: ${bundlePath}`, e);
            return { ...base, error: 'read-failed' };
        }

        // Hash shortcut: if the file is byte-identical to the last patched
        // state, there is nothing to do (no update happened).
        const hash = sha256(raw);
        const storedHash = context.globalState.get<string>(STATE_BUNDLE_HASH);
        const storedAllApplied = context.globalState.get<boolean>(STATE_ALL_APPLIED, false);
        if (!opts?.force && storedHash === hash && storedAllApplied) {
            info(`Copilot bundle unchanged since last successful patch — skipping (hash match).`);
            return { ...base, alreadyPatched: true, skippedByHash: true };
        }

        const health = healthCheck(raw, patches);
        const missingIds = new Set(health.filter(h => !h.applied).map(h => h.id));
        const missing = patches.filter(p => missingIds.has(p.id));

        if (missing.length === 0) {
            info('All Copilot Chat PDF patches are already applied.');
            await context.globalState.update(STATE_BUNDLE_HASH, hash);
            await context.globalState.update(STATE_ALL_APPLIED, true);
            return { ...base, alreadyPatched: true };
        }

        info(`Found ${missing.length} missing Copilot Chat PDF patch(es): ${missing.map(m => m.id).join(', ')}`);

        // Back up before touching the minified bundle.
        const backupPath = backupBundle(bundlePath);
        if (backupPath) {
            pruneBackups(bundlePath, getPatchBackupRetention());
        }
        base.backupPath = backupPath;

        const outcome = applyMissing(raw, missing);

        if (outcome.appliedIds.length > 0) {
            try {
                fs.writeFileSync(bundlePath, outcome.content, 'utf-8');
            } catch (e) {
                err(`Failed to write patched bundle: ${bundlePath}`, e);
                return {
                    ...base,
                    alreadyPatched: false,
                    appliedIds: [],
                    failedIds: [...outcome.appliedIds, ...outcome.failedIds],
                    failedReasons: { ...outcome.failedReasons, write: `Write failed: ${e instanceof Error ? e.message : String(e)}` },
                    error: 'write-failed',
                };
            }
        }

        // Verify by re-reading and re-checking markers.
        let verifyHealth: PatchHealth[] = [];
        try {
            verifyHealth = healthCheck(fs.readFileSync(bundlePath, 'utf-8'), patches);
        } catch (e) {
            err('Failed to re-read bundle for verification', e);
        }
        const stillMissing = verifyHealth.filter(h => !h.applied).map(h => h.id);
        if (stillMissing.length === 0) {
            const finalRaw = fs.readFileSync(bundlePath, 'utf-8');
            await context.globalState.update(STATE_BUNDLE_HASH, sha256(finalRaw));
            await context.globalState.update(STATE_ALL_APPLIED, true);
            info('All Copilot Chat PDF patches verified applied. ✅');
        } else {
            // Some patches remain missing (could not be auto-applied) — record
            // the hash anyway so we don't retry identical failures every 15 min,
            // but only if we actually wrote the file.
            if (outcome.appliedIds.length > 0) {
                const finalRaw = fs.readFileSync(bundlePath, 'utf-8');
                await context.globalState.update(STATE_BUNDLE_HASH, sha256(finalRaw));
            }
            await context.globalState.update(STATE_ALL_APPLIED, false);
            warn(`Verification incomplete — still missing: ${stillMissing.join(', ')}`);
        }

        return {
            ...base,
            alreadyPatched: false,
            appliedIds: outcome.appliedIds,
            failedIds: outcome.failedIds,
            failedReasons: outcome.failedReasons,
            backupPath,
        };
    } catch (e) {
        err('Unexpected error during patch cycle', e);
        return { ...base, error: e instanceof Error ? e.message : String(e) };
    } finally {
        cycleInProgress = false;
    }
}

// ---------------------------------------------------------------------------
// Diagnostics helpers
// ---------------------------------------------------------------------------

/** Human-readable, one-line-per-patch summary of the current bundle state. */
export function describeBundleState(): string {
    const bundlePath = locateCopilotBundle();
    if (!bundlePath) return 'Copilot Chat bundle not found.';
    try {
        const raw = fs.readFileSync(bundlePath, 'utf-8');
        const patches = buildPatches({ maxFileSizeMB: getCopilotMaxFileSizeMB() });
        const health = healthCheck(raw, patches);
        const lines = health.map(h => `  ${h.applied ? '✅' : '❌'} ${h.id} — ${h.description}`);
        const missing = health.filter(h => !h.applied);
        return [
            `Bundle: ${bundlePath}`,
            `Size: ${(raw.length / 1024 / 1024).toFixed(1)} MB`,
            ...lines,
            missing.length === 0
                ? 'All patches applied.'
                : `${missing.length} patch(es) missing.`,
        ].join('\n');
    } catch (e) {
        return `Failed to read bundle: ${e instanceof Error ? e.message : String(e)}`;
    }
}

/** Print the current bundle state to the patcher output channel. */
export function logBundleState(): void {
    output().show(true);
    output().appendLine(describeBundleState());
}
