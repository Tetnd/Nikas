/**
 * Pure Copilot Chat PDF patch ENGINE — no vscode/config/log dependency.
 *
 * Health-check, apply (exact → regex fallback → adaptive), and the
 * alias-safety net live here so the EXACT production logic can be unit-tested
 * from plain Node. `test-patch-drift.js` simulates future bundle generations
 * (renamed minified symbols) and asserts the engine still self-heals — this is
 * what guarantees a VS Code / Copilot update can't strand new users again.
 *
 * manager.ts wires the real VS Code logger into this engine via
 * `setEngineLogger` and re-exports these functions for existing consumers.
 */

import { type PatchDefinition } from './patches.js';

// ---------------------------------------------------------------------------
// Injectable logger (manager.ts supplies the real output channel)
// ---------------------------------------------------------------------------

export interface EngineLogger {
    info?(msg: string): void;
    warn?(msg: string): void;
    err?(msg: string, e?: unknown): void;
}

let _log: EngineLogger = {};
export function setEngineLogger(l: EngineLogger): void {
    _log = l;
}

const info = (m: string) => _log.info?.(m);
const warn = (m: string) => _log.warn?.(m);

// ---------------------------------------------------------------------------
// Health check / applying
// ---------------------------------------------------------------------------

export interface PatchHealth {
    id: string;
    description: string;
    applied: boolean;
}

export function healthCheck(content: string, patches: PatchDefinition[]): PatchHealth[] {
    return patches.map(p => {
        const stringApplied = p.appliedMarkers.some(m => content.includes(m));
        const regexApplied = (p.appliedRegexes ?? []).some(re => re.test(content));
        // Outcome-based: a patch whose FUNCTIONAL result is present counts as
        // applied even when its marker strings use old minified names. This is
        // what makes detection drift-proof (e.g. P2/P7 were false-alarmed as
        // missing in earlier builds because only markers were checked).
        const verified = p.verify ? p.verify(content) : false;
        return {
            id: p.id,
            description: p.description,
            applied: stringApplied || regexApplied || verified,
        };
    });
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
            // Dump the surrounding bundle context so a maintainer can see the
            // new structure without needing the whole (multi-MB) bundle file.
            const ctx = extractDiagnosticContext(working, patch);
            if (ctx) {
                warn(`  Diagnostic context for ${patch.id} (around "${ctx.probe}"):`);
                warn(`  --- START (${ctx.before.length} chars before / ${ctx.after.length} chars after) ---`);
                warn(`  ${ctx.snippet}`);
                warn(`  --- END ${patch.id} diagnostic ---`);
            }
        }
    }

    return { content: working, appliedIds, failedIds, failedReasons };
}

/**
 * Extract a short context window from the bundle around the first diagnostic
 * probe that survives version drift, so a failed patch can be diagnosed from
 * the log alone. Returns undefined if no probe is found.
 */
export function extractDiagnosticContext(
    content: string,
    patch: PatchDefinition,
    windowChars = 220
): { probe: string; before: string; after: string; snippet: string } | undefined {
    const probes = patch.diagnosticProbes ?? [];
    // Fall back to the first replacement's `find` prefix if no probes defined —
    // still better than nothing.
    const candidates = probes.length > 0
        ? probes
        : (patch.replacements[0]?.find ?? []).length > 0
            ? [patch.replacements[0].find.slice(0, 40)]
            : [];

    for (const probe of candidates) {
        const idx = content.indexOf(probe);
        if (idx === -1) continue;
        const start = Math.max(0, idx - windowChars);
        const end = Math.min(content.length, idx + probe.length + windowChars);
        return {
            probe,
            before: content.slice(start, idx),
            after: content.slice(idx + probe.length, end),
            snippet: content.slice(start, end),
        };
    }
    return undefined;
}

/**
 * Module-scope identifiers that are safe to introduce into a minified bundle
 * (Node/JS globals). Everything else must already appear in the bundle or the
 * injected code will throw at runtime (undefined symbol).
 */
const SAFE_GLOBALS = new Set([
    'Buffer.', 'TextEncoder.', 'TextDecoder.', 'JSON.', 'Math.', 'console.',
    'Promise.', 'Object.', 'Array.', 'String.', 'Number.', 'Date.', 'Error.',
    'URL.', 'setTimeout.', 'clearTimeout.', 'setInterval.', 'clearInterval.',
    'globalThis.', 'process.', 'Symbol.', 'Reflect.', 'RegExp.', 'Boolean.',
    'BigInt.', 'Map.', 'Set.', 'WeakMap.', 'WeakSet.', 'parseInt.', 'parseFloat.',
    'isNaN.', 'isFinite.', 'undefined.', 'NaN.', 'Infinity.',
]);

/**
 * Return `Ident.` tokens present in `patched` but never in `original` (and not
 * safe globals). Regex fallbacks / adaptive injections may reference minified
 * module aliases that a drifted bundle renamed; such injections throw at
 * runtime (e.g. "Cannot read properties of undefined (reading '...')"). We
 * refuse to apply them instead of corrupting the bundle.
 */
export function introducedAliases(original: string, patched: string): string[] {
    const originalTokens = new Set<string>();
    const re = /[A-Za-z_$][\w$]*\./g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(original))) originalTokens.add(m[0]);

    const added = new Set<string>();
    while ((m = re.exec(patched))) {
        const tok = m[0];
        if (!originalTokens.has(tok) && !SAFE_GLOBALS.has(tok)) added.add(tok);
    }
    return [...added];
}

export interface ApplyOneResult {
    success: boolean;
    content: string;
    reason: string;
}

export function applyOne(content: string, patch: PatchDefinition): ApplyOneResult {
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
                // Safety net: a fallback that introduces unknown module aliases
                // would crash at runtime. Refuse it (the patch then reports as
                // "needs manual review" instead of corrupting the bundle).
                const bad = introducedAliases(content, replaced);
                if (bad.length > 0) {
                    warn(`Refusing regex fallback for ${patch.id}: injected code references aliases never present in this bundle (${bad.join(', ')}). The bundle drifted too far — skipping instead of risking a crash.`);
                    continue;
                }
                return { success: true, content: replaced, reason: '' };
            }
        }
    }

    // 3) Adaptive replacement (the drift-proof tier): locate the target region
    //    via a STABLE content anchor, extract the real minified identifiers
    //    from the matched region, and rebuild the find/replace using only those
    //    names. Guards: (a) the rebuilt `find` MUST exist in the bundle (we never
    //    inject blindly), (b) injected identifiers are captured from the bundle
    //    or are safe globals / inline require, so the alias-safety net passes.
    if (patch.adaptive) {
        const ad = patch.adaptive;
        const re = new RegExp(ad.pattern.source, ad.pattern.flags);
        const m = re.exec(content);
        if (m) {
            const built = ad.build(m, content);
            if (built) {
                const count = content.split(built.find).length - 1;
                if (count === 0) {
                    warn(`Adaptive rule for ${patch.id} located its anchor but the rebuilt find string is absent (${built.find.slice(0, 60)}…). Skipping.`);
                } else if (count > 1) {
                    warn(`Adaptive rule for ${patch.id} matched ${count} locations — refusing ambiguous injection.`);
                } else {
                    const replaced = content.replace(built.find, built.replace);
                    const bad = introducedAliases(content, replaced);
                    if (bad.length > 0) {
                        warn(`Refusing adaptive injection for ${patch.id}: injected code references aliases never present in this bundle (${bad.join(', ')}).`);
                    } else {
                        return { success: true, content: replaced, reason: '' };
                    }
                }
            } else {
                warn(`Adaptive rule for ${patch.id} found its anchor but could not rebuild a safe find/replace (structure drifted beyond the template).`);
            }
        }
    }

    return {
        success: false,
        content,
        reason: 'No matching snippet found. The Copilot bundle structure likely changed — this patch needs a manual update (see README re-patch recipe).',
    };
}
