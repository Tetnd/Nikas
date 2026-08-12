/**
 * Copilot Chat PDF patch definitions.
 *
 * Microsoft's Copilot Chat extension drops PDF attachments for third-party
 * chat providers (like Nikas/DeepSeek). The fixes must be applied to the
 * INSTALLED Copilot bundle (`.../extensions/copilot/dist/extension.js`), which
 * is a minified file that every Copilot Chat update overwrites — wiping the
 * patches.
 *
 * This module encodes the exact, verified find/replace pairs (plus markers to
 * detect whether a patch is already applied). The strings below were verified
 * against the Copilot Chat bundle with build hash `df53daabb1` (2026-08-08).
 * Each patch carries a best-effort regex fallback so that after a future
 * update changes minified symbol names, we can still (usually) re-apply.
 *
 * Safety: every patch is purely additive — if the exact find string isn't
 * present we do NOT touch the file, and we report the patch as "needs manual
 * review" instead of guessing.
 */

export interface PatchReplacement {
    /** Exact snippet present in the UNPATCHED bundle. */
    find: string;
    /** Replacement snippet. Must preserve the surrounding minified syntax. */
    replace: string;
}

/**
 * Self-discovering patch rule (the version-drift-proof tier).
 *
 * Instead of hardcoding minified symbol names (kkn/Fyn, RCt/Jht, VD/mB, ...)
 * that every Copilot bundle update renames, an adaptive rule:
 *   1. LOCATES the target region via a stable *content* anchor (error
 *      strings, property names, API constants — these are never minified).
 *   2. EXTRACTS the real minified identifiers from the matched region.
 *   3. REBUILDS the exact find/replace using ONLY the extracted names.
 *
 * This is what keeps new users working after Copilot renames its symbols —
 * the patch never depends on a name that can drift.
 */
export interface AdaptiveReplacement {
    /**
     * Regex that locates the target region (usually via a stable string or
     * property anchor). Capture groups may carry the identifiers to preserve.
     */
    pattern: RegExp;
    /**
     * Build the exact find/replace from the match. Return `undefined` to skip
     * (e.g. the matched region is already in the desired state). `find` MUST
     * be a substring of `content` (the caller verifies before applying).
     */
    build: (match: RegExpMatchArray, content: string) => { find: string; replace: string } | undefined;
}

export interface PatchDefinition {
    /** Stable id (P1..P10) — matches the recipe's numbering. */
    id: string;
    description: string;
    /** If ANY of these strings is present, the patch is considered applied. */
    appliedMarkers: string[];
    /**
     * Optional regex-based applied markers. If any of these regexes matches,
     * the patch is considered applied. Useful when the exact applied state
     * depends on a renamed minified symbol (e.g. the endpoint variable) that
     * a fixed string can't capture.
     */
    appliedRegexes?: RegExp[];
    /** Exact find/replace pairs; the first whose `find` occurs wins. */
    replacements: PatchReplacement[];
    /** Regex fallbacks tried only if no exact find matches (version drift). */
    regexFallbacks?: { pattern: RegExp; replacement: string | ((substring: string, ...args: any[]) => string) }[];
    /**
     * Self-discovering rule: locates the target via stable content anchors and
     * extracts the real minified names at apply time. Tried after exact finds
     * and regex fallbacks. This is the tier that survives arbitrary renames.
     */
    adaptive?: AdaptiveReplacement;
    /**
     * Outcome-based applied check: returns true when the SEMANTIC result is
     * present (e.g. "the allowlist fn contains a deepseek check", "the PDF
     * gate no longer references supportsVision"), regardless of the minified
     * names involved. Consulted by health checks in addition to markers.
     */
    verify?: (content: string) => boolean;
    /**
     * Diagnostic probes: distinctive substrings that are likely to survive
     * version drift and sit NEAR the code this patch targets. When a patch
     * can't be applied, the manager dumps a short context window around the
     * first probe found so a maintainer can see the new bundle structure
     * without needing the whole (multi-MB) bundle file.
     */
    diagnosticProbes?: string[];
    /** Core patches are essential; supporting ones are best-effort extras. */
    core: boolean;
}

export interface PatchBuildOptions {
    /** Max file read size in MB for the PDF/file-size gate (default 100). */
    maxFileSizeMB: number;
}

/**
 * Build the full set of Copilot Chat PDF patches.
 * `maxFileSizeMB` is injected so the 5MB → N MB limit patch follows the
 * `nikas.copilotMaxFileSizeMB` setting.
 */
export function buildPatches(options: PatchBuildOptions): PatchDefinition[] {
    const mb = options.maxFileSizeMB;

    return [
        // ── PATCH 1 — Allow DeepSeek models to receive PDFs ───────────────
        {
            id: 'P1',
            description: 'Allow DeepSeek-family models to receive PDFs (kkn allowlist)',
            appliedMarkers: [
                `(n.family||"").startsWith("deepseek")`,
            ],
            replacements: [
                {
                    // Copilot 0.61.0 (2026-08): allowlist fn renamed to Fyn with
                    // predicates Rv/Lj/t4.
                    find: `function Fyn(n){return Rv(n)||Lj(n)||t4(n)}`,
                    replace: `function Fyn(n){return Rv(n)||Lj(n)||t4(n)||(n.family||"").startsWith("deepseek")}`,
                },
                {
                    find: `function kkn(n){return q_(n)||qj(n)||j3(n)}`,
                    replace: `function kkn(n){return q_(n)||qj(n)||j3(n)||(n.family||"").startsWith("deepseek")}`,
                },
            ],
            regexFallbacks: [
                {
                    // Symbol names of the allowlist fn + predicates may change;
                    // match the 3-predicate allowlist shape generically (2-3 char
                    // name covers kkn, lkn, Fyn, ...). The fn name AND body are
                    // captured so the deepseek clause is injected INSIDE the
                    // function body (before the closing `}`) — appending after
                    // the `}` would produce invalid JS (`function x(){...}||(...)`).
                    pattern: /function (kkn|[\w$]{2,3})\(n\)\{return ([\w$]+\(n\)\|\|[\w$]+\(n\)\|\|[\w$]+\(n\))\}/,
                    replacement: (_m: string, fn: string, body: string) =>
                        `function ${fn}(n){return ${body}||(n.family||"").startsWith("deepseek")}`,
                },
            ],
            adaptive: {
                // Stable anchor: the PDF-omitted error string is never minified.
                // From its surroundings we discover the ALLOWLIST FN name — whatever
                // the minifier called it (kkn, lkn, Fyn, ...).
                pattern: /does not support PDF documents\./,
                build: (m, content) => {
                    const idx = m.index ?? 0;
                    const before = content.slice(Math.max(0, idx - 400), idx);
                    const gate = /!([\w$]{1,3})\(([\w$]+(?:\.[\w$]+)*)\)\)\{if\(this\.props\.omitReferences\)return/.exec(before);
                    if (!gate) return undefined;
                    const fn = gate[1];
                    const def = new RegExp(`function ${fn}\\(n\\)\\{return ([^}]+)\\}`).exec(content);
                    if (!def) return undefined;
                    const body = def[1];
                    if (body.includes('startsWith("deepseek")')) return undefined; // already applied
                    return {
                        find: `function ${fn}(n){return ${body}}`,
                        replace: `function ${fn}(n){return ${body}||(n.family||"").startsWith("deepseek")}`,
                    };
                },
            },
            verify: (content) => {
                // Outcome: the allowlist fn (found via the PDF gate) contains a
                // deepseek-family check — regardless of its minified name.
                const idx = content.indexOf('does not support PDF documents.');
                if (idx === -1) return false;
                const before = content.slice(Math.max(0, idx - 400), idx);
                const gate = /!([\w$]{1,3})\(([\w$]+(?:\.[\w$]+)*)\)\)\{if\(this\.props\.omitReferences\)return/.exec(before);
                if (!gate) return false;
                const fn = gate[1];
                return new RegExp(`function ${fn}\\(n\\)\\{return [^}]*?startsWith\\(\"deepseek\"\\)`).test(content);
            },
            diagnosticProbes: [
                `startsWith("deepseek")`,
                `function kkn`,
                `does not support PDF`,
            ],
            core: true,
        },

        // ── PATCH 2 — Raise the 5 MB file-read limit to N MB (default 100) ─
        {
            id: 'P2',
            description: `Raise the max file size Copilot will read (5 MB → ${mb} MB)`,
            appliedMarkers: [
                `RCt=1024*1024*${mb}`,
                // Copilot 0.61.0 ships the cap natively (e.g. `Jht=1024*1024*250`);
                // accept any identifier prefix so a matching native value isn't
                // reported as missing.
                `=1024*1024*${mb}`,
            ],
            replacements: [
                {
                    find: `RCt=1024*1024*5;`,
                    replace: `RCt=1024*1024*${mb};`,
                },
            ],
            regexFallbacks: [
                {
                    // The constant name may change; search for the value it is
                    // compared against near the "max file size" error message.
                    // `$1` preserves whatever identifier name matched.
                    pattern: /(RCt|[\w$]{2,3})=1024\*1024\*5;/,
                    replacement: `$1=1024*1024*${mb};`,
                },
                {
                    // Newer bundles may ship a different cap natively (e.g. 250);
                    // normalize whatever `1024*1024*N` value is present to the
                    // configured MB so a mismatch still gets fixed.
                    pattern: /([\w$]{2,3})=1024\*1024\*\d+;/,
                    replacement: `$1=1024*1024*${mb};`,
                },
            ],
            adaptive: {
                // Stable anchor: the "max file size" error strings are never
                // minified. From them we discover the SIZE CONST name (RCt, xCt,
                // Jht, ...) that the read gate actually compares against.
                pattern: /EXCEEDS max file size/,
                build: (m, content) => {
                    const idx = m.index ?? 0;
                    // The `if(r.size>CONST)` gate sits ~230 chars before the error
                    // string (the LARGE-file template is between them) — window
                    // must be wide enough to reach it.
                    const before = content.slice(Math.max(0, idx - 400), idx);
                    const sizeCheck = /if\(r\.size>([\w$]{2,3})\)/.exec(before);
                    if (!sizeCheck) return undefined;
                    const c = sizeCheck[1];
                    const decl = new RegExp(`${c}=1024\\*1024\\*\\d+;`).exec(content);
                    if (!decl) return undefined;
                    // The VALUE is the number immediately before `;` — matching the
                    // first `\d+` would grab the 1024 multiplier instead of the 5.
                    const cur = /(\d+);/.exec(decl[0]);
                    if (cur && Number(cur[1]) >= mb) return undefined; // already at/above target
                    return { find: decl[0], replace: `${c}=1024*1024*${mb};` };
                },
            },
            verify: (content) => {
                // Outcome: the size const actually used by the read gate is set to
                // >= the configured MB — regardless of its minified name.
                const idx = content.indexOf('EXCEEDS max file size');
                if (idx === -1) return false;
                // Same wide window as the adaptive builder (~230 chars to the gate).
                const before = content.slice(Math.max(0, idx - 400), idx);
                const sizeCheck = /if\(r\.size>([\w$]{2,3})\)/.exec(before);
                if (!sizeCheck) return false;
                const c = sizeCheck[1];
                const decl = new RegExp(`${c}=1024\\*1024\\*(\\d+);`).exec(content);
                return !!decl && Number(decl[1]) >= mb;
            },
            diagnosticProbes: [
                `1024*1024*5`,
                `max file size`,
                `too large to read`,
            ],
            core: true,
        },

        // ── PATCH 3 — Let PDFs bypass `omitContents` in agent mode ─────────
        {
            id: 'P3',
            description: "Let PDFs bypass omitContents so they reach the PDF branch",
            appliedMarkers: [
                `omitContents&&!/\\.pdf$/i.test`,
            ],
            replacements: [
                {
                    find: `if(this.props.omitContents){let u=this.promptPathRepresentationService.getFilePath(o),d={};return this.props.variableName&&(d.id=this.props.variableName),d.filePath=u,vscpp(W,{name:"attachment",attrs:d})}`,
                    replace: `if(this.props.omitContents&&!/\\.pdf$/i.test(o.path)){let u=this.promptPathRepresentationService.getFilePath(o),d={};return this.props.variableName&&(d.id=this.props.variableName),d.filePath=u,vscpp(W,{name:"attachment",attrs:d})}`,
                },
            ],
            diagnosticProbes: [
                `omitContents`,
                `getFilePath`,
                `attachment`,
            ],
            core: true,
        },

        // ── PATCH 4 — Remove the supportsVision requirement on the PDF gate ─
        {
            id: 'P4',
            description: 'Remove the supportsVision requirement on the PDF gate',
            appliedMarkers: [
                `if(/\\.pdf$/i.test(o.path)){if(!kkn(this.promptEndpoint)){`,
                // Copilot 0.61.0 (2026-08): allowlist fn renamed to Fyn.
                `if(/\\.pdf$/i.test(o.path)){if(!Fyn(this.promptEndpoint)){`,
            ],
            // The gate is already correct (no supportsVision requirement) when the
            // PDF branch is gated only by `!<allowlist>(<endpoint>)` — regardless of
            // the minified allowlist/endpoint variable names (kkn, lkn, Fyn, ...).
            // Without this, a bundle that already has the patched form with renamed
            // symbols (e.g. `!Fyn(t)`) would be falsely reported as "P4 missing".
            //
            // The `((?!\.supportsVision)[\s\S])*?` between the `.pdf$` test and the
            // `if(!<fn>(...))` gate tolerates any instrumentation/statements injected
            // between them (e.g. a `__trace('B-PDF-ENTRY ...')` debug call seen on
            // some builds) while REFUSING to cross a `supportsVision` check — so it
            // still does NOT match an unpatched gate (`!...supportsVision||!<fn>(...)`
            // has no `if(!<fn>(` sequence in a supportsVision-free window), and it
            // won't false-match by jumping to an unrelated later `if(!fn(x)){` either.
            appliedRegexes: [
                /if\(\/\\\.pdf\$\/i\.test\(o\.path\)\)\{((?!\.supportsVision)[\s\S])*?if\(![\w$]{2,3}\([\w$]+(?:\.[\w$]+)*\)\)\{/,
            ],
            replacements: [
                {
                    // Copilot 0.61.0 (2026-08): allowlist fn renamed to Fyn.
                    find: `if(/\\.pdf$/i.test(o.path)){if(!this.promptEndpoint.supportsVision||!Fyn(this.promptEndpoint)){`,
                    replace: `if(/\\.pdf$/i.test(o.path)){if(!Fyn(this.promptEndpoint)){`,
                },
                {
                    // Current (2026-08) form: negated gate.
                    find: `if(/\\.pdf$/i.test(o.path)){if(!this.promptEndpoint.supportsVision||!kkn(this.promptEndpoint)){`,
                    replace: `if(/\\.pdf$/i.test(o.path)){if(!kkn(this.promptEndpoint)){`,
                },
                {
                    // Older form from the original recipe.
                    find: `if(kkn(this.promptEndpoint)&&this.promptEndpoint.supportsVision)`,
                    replace: `if(kkn(this.promptEndpoint))`,
                },
            ],
            regexFallbacks: [
                {
                    // Negated gate, version-drift tolerant: the endpoint accessor
                    // (this.promptEndpoint / t / e.model / etc.) and the allowlist
                    // fn name (kkn/lkn/Fyn/...) may be renamed by minifiers, and the
                    // `supportsVision` check may appear before OR after the allowlist
                    // call. Matches the PDF gate with a `supportsVision` requirement
                    // and strips it, keeping the allowlist check (name + endpoint
                    // captured and preserved).
                    pattern: /if\(\/\\\.pdf\$\/i\.test\(o\.path\)\)\{if\((![\w$]+(?:\.[\w$]+)*\.supportsVision\|\|!([\w$]{2,3})\(([\w$]+(?:\.[\w$]+)*)\)|!([\w$]{2,3})\(([\w$]+(?:\.[\w$]+)*)\)\|\|![\w$]+(?:\.[\w$]+)*\.supportsVision)\)\{/,
                    replacement: (_m: string, _a: string, fn1: string | undefined, ep1: string | undefined, fn2: string | undefined, ep2: string | undefined) => {
                        const fn = fn1 || fn2 || 'kkn';
                        const endpoint = ep1 || ep2 || 'this.promptEndpoint';
                        return `if(\/\\.pdf\$/i.test(o.path)){if(!${fn}(${endpoint})){`;
                    },
                },
                {
                    // Positive gate, older form (original recipe): if(kkn(<endpoint>)&&<endpoint>.supportsVision)
                    pattern: /if\(kkn\(([\w$]+(?:\.[\w$]+)*)\)&&\1\.supportsVision\)/,
                    replacement: (_m: string, endpoint: string) => `if(kkn(${endpoint}))`,
                },
                {
                    // Positive gate, tolerant of differing endpoint expressions:
                    // if(kkn(<a>)&&<b>.supportsVision) → if(kkn(<a>))
                    pattern: /if\(kkn\(([\w$]+(?:\.[\w$]+)*)\)&&[\w$]+(?:\.[\w$]+)*\.supportsVision\)/,
                    replacement: (_m: string, endpoint: string) => `if(kkn(${endpoint}))`,
                },
            ],
            adaptive: {
                // Stable anchor: the PDF-omitted error string. From the window
                // before it we discover the actual gate shape AND the allowlist fn
                // name, so we rebuild the gate using ONLY extracted identifiers.
                pattern: /does not support PDF documents\./,
                build: (m, content) => {
                    const idx = m.index ?? 0;
                    const before = content.slice(Math.max(0, idx - 400), idx);
                    // Negated gate: if(!X.supportsVision||!FN(EP)){
                    const neg = /if\(!([\w$]+(?:\.[\w$]+)*)\.supportsVision\|\|!([\w$]{1,3})\(([\w$]+(?:\.[\w$]+)*)\)\)\{/.exec(before);
                    if (neg) {
                        return { find: neg[0], replace: `if(!${neg[2]}(${neg[3]})){` };
                    }
                    // Positive gate: if(FN(EP)&&EP.supportsVision)
                    const pos = /if\(([\w$]{1,3})\(([\w$]+(?:\.[\w$]+)*)\)&&\2\.supportsVision\)/.exec(before);
                    if (pos) return { find: pos[0], replace: `if(${pos[1]}(${pos[2]}))` };
                    return undefined;
                },
            },
            verify: (content) => {
                // Outcome: the gate for the PDF-omitted error no longer mentions
                // supportsVision AND still calls a single allowlist fn.
                const idx = content.indexOf('does not support PDF documents.');
                if (idx === -1) return false;
                const before = content.slice(Math.max(0, idx - 400), idx);
                if (before.includes('supportsVision')) return false;
                return /!([\w$]{1,3})\(([\w$]+(?:\.[\w$]+)*)\)\)\{if\(this\.props\.omitReferences\)return/.test(before);
            },
            diagnosticProbes: [
                // The error message only appears inside the actual PDF gate, so it
                // points the diagnostic at the right spot. (Plain "supportsVision"
                // is too generic — it also matches model-capability constructors.)
                `does not support PDF documents`,
                `.pdf$/i.test(o.path)`,
                `kkn(`,
            ],
            core: true,
        },

        // ── PATCH 5 — Convert Document raw parts to LanguageModelDataPart ──
        {
            id: 'P5',
            description: 'Convert Document content parts to LanguageModelDataPart (so Nikas receives the PDF)',
            // Alias-agnostic marker: matches the injected Document branch in the
            // OpenAI-mode converter regardless of the minified namespace alias.
            // Distinct from P10's marker (t.documentData vs a.documentData) so a
            // P10-only injection is NOT mistaken for P5 being applied.
            appliedMarkers: [
                `ChatCompletionContentPartKind.Document){let dd=t.documentData`,
            ],
            replacements: [
                {
                    // Copilot 0.61.0 (2026-08): enum namespace renamed to mB and the
                    // module no longer imports vscode — use an inline require so the
                    // patch stays independent of module-level alias names.
                    find: `if(t.type===mB.ChatCompletionContentPartKind.Document)return;`,
                    replace: `if(t.type===mB.ChatCompletionContentPartKind.Document){let dd=t.documentData,db=typeof dd.data=="string"?Buffer.from(dd.data,"base64"):Buffer.from(dd.data);return new (require("vscode").LanguageModelDataPart)(new Uint8Array(db),dd.mediaType||"application/pdf")}`,
                },
                {
                    find: `if(t.type===VD.ChatCompletionContentPartKind.Document)return;`,
                    replace: `if(t.type===VD.ChatCompletionContentPartKind.Document){let dd=t.documentData,db=typeof dd.data=="string"?Buffer.from(dd.data,"base64"):Buffer.from(dd.data);return new FA.LanguageModelDataPart(new Uint8Array(db),dd.mediaType||"application/pdf")}`,
                },
            ],
            regexFallbacks: [
                {
                    // Enum namespace name may change; capture and preserve it while
                    // converting the Document case to a LanguageModelDataPart.
                    pattern: /if\(t\.type===(\w{2,3})\.ChatCompletionContentPartKind\.Document\)return;/,
                    replacement: (_m: string, ns: string) => `if(t.type===${ns}.ChatCompletionContentPartKind.Document){let dd=t.documentData,db=typeof dd.data=="string"?Buffer.from(dd.data,"base64"):Buffer.from(dd.data);return new (require("vscode").LanguageModelDataPart)(new Uint8Array(db),dd.mediaType||"application/pdf")}`,
                },
            ],
            adaptive: {
                // Stable anchor: the enum member name `ChatCompletionContentPartKind`
                // (an export — never minified) plus the bare `return;` Document case.
                // The NAMESPACE alias (VD, mB, ...) is captured and preserved, so the
                // injected branch always references a symbol that exists in THIS
                // bundle. Uses an inline require("vscode") so no module alias is
                // introduced (passes the runtime alias-safety net).
                pattern: /if\(t\.type===(\w{1,3})\.ChatCompletionContentPartKind\.Document\)return;/,
                build: (m) => {
                    const ns = m[1];
                    return {
                        find: m[0],
                        replace: `if(t.type===${ns}.ChatCompletionContentPartKind.Document){let dd=t.documentData,db=typeof dd.data=="string"?Buffer.from(dd.data,"base64"):Buffer.from(dd.data);return new (require("vscode").LanguageModelDataPart)(new Uint8Array(db),dd.mediaType||"application/pdf")}`,
                    };
                },
            },
            verify: (content) => {
                // Outcome: the OpenAI-mode converter's Document case now produces a
                // LanguageModelDataPart (alias-agnostic marker).
                return content.includes(`ChatCompletionContentPartKind.Document){let dd=t.documentData`);
            },
            diagnosticProbes: [
                `ChatCompletionContentPartKind.Document`,
                `documentData`,
                `LanguageModelDataPart`,
            ],
            core: true,
        },

        // ── PATCH 6 — Forward binary PDFs as `document` parts (sae path) ───
        {
            id: 'P6',
            description: 'Forward binary PDF data parts as Anthropic-style document parts',
            appliedMarkers: [
                `mimeType==="application/pdf"?e.push({type:"document"`,
            ],
            replacements: [
                {
                    find: `t.mimeType!==is.StatefulMarker&&e.push({type:"image",source:{type:"base64",data:Buffer.from(t.data).toString("base64"),media_type:t.mimeType}})`,
                    replace: `t.mimeType!==is.StatefulMarker&&(t.mimeType==="application/pdf"?e.push({type:"document",source:{type:"base64",data:Buffer.from(t.data).toString("base64"),media_type:"application/pdf"}}):e.push({type:"image",source:{type:"base64",data:Buffer.from(t.data).toString("base64"),media_type:t.mimeType}}))`,
                },
            ],
            diagnosticProbes: [
                `StatefulMarker`,
                `media_type:t.mimeType`,
                `type:"image",source`,
            ],
            core: false,
        },

        // ── PATCH 7 — Agent path renders PDF binary as Lu.Document ─────────
        {
            id: 'P7',
            description: 'Render PDF binary as a Document user message (chat path natively, agent path via patch)',
            appliedMarkers: [
                `vscpp(Lu.Document,{data:d,mediaType:"application/pdf"})`,
                // Copilot 0.61.0 (2026-08): native chat-path renderer (ns = iu).
                `vscpp(iu.Document,{data:d,mediaType:"application/pdf"})`,
            ],
            // Copilot 0.61.0 renders PDF binaries natively as
            // `vscpp(<ns>.Document,{data:d,mediaType:"application/pdf"})` in the chat
            // path (ns = iu) — the functional outcome this patch exists for. Accept
            // any namespace so bundles with the native Document renderer don't
            // false-alarm; the agent-path injection below still runs on older
            // bundles that render PDFs as plain parts. (The 0.61 agent module has no
            // Document component, so agent-path injection is only feasible on older
            // bundles that carry one.)
            appliedRegexes: [
                /vscpp\([\w$]+\.Document,\{data:d,mediaType:"application\/pdf"\}\)\)/,
            ],
            replacements: [],
            regexFallbacks: [
                {
                    // If an update reverts the agent PDF path to emit the PDF as
                    // a plain part (not Lu.Document), insert the Lu.Document.
                    pattern: /let d=Buffer\.from\(u\)\.toString\("base64"\);return vscpp\(t2t\.UserMessage,\{priority:0\},vscpp\((?!Lu\.Document)/,
                    replacement: `let d=Buffer.from(u).toString("base64");return vscpp(t2t.UserMessage,{priority:0},vscpp(Lu.Document,{data:d,mediaType:"application/pdf"}),vscpp(`,
                },
            ],
            diagnosticProbes: [
                `UserMessage,{priority:0}`,
                `Buffer.from(u).toString("base64")`,
                `Lu.Document`,
            ],
            verify: (content) => {
                // Outcome: a Document renderer carrying the PDF binary exists —
                // whatever the namespace alias (Lu, iu, zz, ...) the minifier chose.
                return /vscpp\([\w$]+\.Document,\{data:d,mediaType:"application\/pdf"\}\)\)/.test(content);
            },
            core: false,
        },

        // ── PATCH 8 — Include binary parts in the chat-variables filter ────
        {
            id: 'P8',
            description: 'Include binary chat variables in the forwarded set (s(v)||c(v))',
            appliedMarkers: [
                `filter(v=>s(v)||c(v)`,
                // Copilot 0.61.0 (2026-08): filter lambda param renamed v → _.
                `filter(_=>s(_)||c(_)`,
            ],
            replacements: [
                {
                    // Copilot 0.61.0 (2026-08): filter lambda param renamed v → _.
                    find: `u=this.props.chatVariables.filter(_=>s(_)||l(_)),d=this.props.chatVariables.filter(_=>!s(_)&&!c(_))`,
                    replace: `u=this.props.chatVariables.filter(_=>s(_)||c(_)||l(_)),d=this.props.chatVariables.filter(_=>!s(_)&&!c(_))`,
                },
                {
                    // Older form: the binary filter `c` was dropped, leaving only
                    // text `s` OR reference `l`.
                    find: `u=this.props.chatVariables.filter(v=>s(v)||l(v)),d=this.props.chatVariables.filter(v=>!s(v)&&!c(v))`,
                    replace: `u=this.props.chatVariables.filter(v=>s(v)||c(v)||l(v)),d=this.props.chatVariables.filter(v=>!s(v)&&!c(v))`,
                },
                {
                    // Original recipe form.
                    find: `u=this.props.chatVariables.filter(v=>s(v))`,
                    replace: `u=this.props.chatVariables.filter(v=>s(v)||c(v))`,
                },
            ],
            regexFallbacks: [
                {
                    // Match a chatVariables filter that forwards only text `s` plus
                    // reference `l` and OR in the binary check `c`. Lambda param name
                    // (v/_/x/...) is captured and preserved.
                    pattern: /u=this\.props\.chatVariables\.filter\(([\w$])=>s\(\1\)\|\|l\(\1\)\)/,
                    replacement: (_m: string, p: string) => `u=this.props.chatVariables.filter(${p}=>s(${p})||c(${p})||l(${p}))`,
                },
                {
                    // Match a chatVariables filter that forwards only text (`s`)
                    // and OR in the binary check `c`.
                    pattern: /this\.props\.chatVariables\.filter\(v=>s\(v\)\)/,
                    replacement: `this.props.chatVariables.filter(v=>s(v)||c(v))`,
                },
            ],
            adaptive: {
                // Stable anchor: the `this.props.chatVariables.filter` render block
                // with its two-filter split (forwarded vs deferred). Captures the
                // lambda PARAM name AND the predicate fn names (s/l/c) so the rewrite
                // preserves whatever the minifier chose — any generation, any names.
                pattern: /u=this\.props\.chatVariables\.filter\(([\w$])=>([\w$]+)\(\1\)\|\|([\w$]+)\(\1\)\),d=this\.props\.chatVariables\.filter\(\1=>!([\w$]+)\(\1\)&&!([\w$]+)\(\1\)\)/,
                build: (m) => {
                    const [, p, s, l, s2, c] = m;
                    if (s !== s2) return undefined; // sanity: same text predicate in both filters
                    const find = m[0];
                    if (find.includes(`||${c}(${p})`)) return undefined; // already applied
                    const replace = `u=this.props.chatVariables.filter(${p}=>${s}(${p})||${c}(${p})||${l}(${p})),d=this.props.chatVariables.filter(${p}=>!${s}(${p})&&!${c}(${p}))`;
                    return { find, replace };
                },
            },
            verify: (content) => {
                // Outcome: the forwarded chat-variables filter ORs in the binary
                // check (three predicates) — any param/predicate names. No trailing
                // `)` required: the two filters are comma-separated (`u=...,d=...`).
                return /u=this\.props\.chatVariables\.filter\(([\w$])=>([\w$]+)\(\1\)\|\|([\w$]+)\(\1\)\|\|([\w$]+)\(\1\)/.test(content);
            },
            diagnosticProbes: [
                `chatVariables.filter`,
                `StatefulMarker`,
                `filter(v=>s(v)`,
            ],
            core: true,
        },

        // ── PATCH 9 — Shorten the grep_search "No matches found" hint ──────
        //
        // The Copilot `grep_search` tool appends a verbose 3-line hint to every
        // zero-result search (unless includeIgnoredFiles is set). It reads the
        // search.exclude config, lists the (mostly default) patterns, and
        // produces ~340 chars of boilerplate that gets injected back into the
        // model context on EVERY empty search. This patch shortens it to a
        // single actionable line (~95 chars) and drops the config read.
        {
            id: 'P9',
            description: 'Shorten the verbose grep_search "No matches found" hint (less context/token noise)',
            appliedMarkers: [
                'w=`If the files are ignored or excluded, retry with "includeIgnoredFiles": true.`',
            ],
            replacements: [
                {
                    // \n are real LF newlines inside the minified template literal.
                    find: 'if(!_.length&&!h){let E=this.configurationService.getNonExtensionConfig("search.exclude"),x=[];if(E)for(let[I,S]of Object.entries(E))S&&x.push(I);w=`Your search pattern might be excluded completely by either the search.exclude settings or .*ignore files.\nIf you believe that it should have results, you can check into the .*ignore files and the exclude setting (here are some excluded patterns for reference:[${x.join(",")}]).\nThen if you want to include those files you can call the tool again by setting "includeIgnoredFiles" to true.`}',
                    replace: 'if(!_.length&&!h){w=`If the files are ignored or excluded, retry with "includeIgnoredFiles": true.`}',
                },
            ],
            regexFallbacks: [
                {
                    // Version-drift fallback: shorten only the hint text, keep surrounding syntax.
                    pattern: /w=`Your search pattern might be excluded completely by either the search\.exclude settings or \.\*ignore files\.[\s\S]*?includeIgnoredFiles" to true\.`/,
                    replacement: 'w=`If the files are ignored or excluded, retry with "includeIgnoredFiles": true.`',
                },
            ],
            diagnosticProbes: [
                'Your search pattern might be excluded',
                'includeIgnoredFiles',
                'search.exclude',
            ],
            core: false,
        },

        // ── PATCH 10 — Forward PDFs through kAn (LM request part converter) ─
        //
        // `kAn` converts raw chat messages into the LM request parts sent to
        // extension-contributed providers (Nikas). It handles Text, Image,
        // CacheBreakpoint and Opaque parts — but had NO Document case, so the
        // `Lu.Document` produced by `_b` (P4/P7) was SILENTLY DROPPED before
        // the provider ever saw it. This is the drop point behind "chip shows
        // but the model never receives the PDF" (images worked because the
        // Image branch exists; P5 only patched the OpenAI-mode converter).
        {
            id: 'P10',
            description: 'Forward Document (PDF) parts through kAn so they reach LM providers as data parts',
            // Alias-agnostic marker: matches the injected Document branch in kAn
            // no matter what the minifier renamed the namespace alias to.
            appliedMarkers: [
                `ChatCompletionContentPartKind.Document){let dd=a.documentData`,
            ],
            replacements: [
                {
                    find: `else if(a.type===UL.Raw.ChatCompletionContentPartKind.CacheBreakpoint)e.emitCacheBreakpoints&&o.push(new FA.LanguageModelDataPart(new TextEncoder().encode("ephemeral"),is.CacheControl));else if(a.type===UL.Raw.ChatCompletionContentPartKind.Opaque){let s=NEe(a);`,
                    replace: `else if(a.type===UL.Raw.ChatCompletionContentPartKind.Document){let dd=a.documentData,db=typeof dd.data=="string"?Buffer.from(dd.data,"base64"):Buffer.from(dd.data);o.push(new FA.LanguageModelDataPart(new Uint8Array(db),dd.mediaType||"application/pdf"))}else if(a.type===UL.Raw.ChatCompletionContentPartKind.CacheBreakpoint)e.emitCacheBreakpoints&&o.push(new FA.LanguageModelDataPart(new TextEncoder().encode("ephemeral"),is.CacheControl));else if(a.type===UL.Raw.ChatCompletionContentPartKind.Opaque){let s=NEe(a);`,
                },
            ],
            regexFallbacks: [
                {
                    // Version-drift fallback: insert the Document branch right
                    // before the CacheBreakpoint branch in kAn.
                    //
                    // IMPORTANT: the injected branch MUST reuse the aliases
                    // CAPTURED from the matched bundle (the Raw-namespace alias
                    // and the LanguageModelDataPart alias). Hardcoding aliases
                    // from one build (e.g. UL / FA) crashes bundles where the
                    // minifier renamed them — the runtime error was exactly
                    // "Cannot read properties of undefined (reading
                    // 'ChatCompletionContentPartKind')" when `UL.Raw` was
                    // undefined at the injection site.
                    pattern: /else if\(a\.type===([\w$]+)\.Raw\.ChatCompletionContentPartKind\.CacheBreakpoint\)e\.emitCacheBreakpoints&&o\.push\(new ([\w$]+)\.LanguageModelDataPart\(new TextEncoder\(\)\.encode\("ephemeral"\),[\w$]+\.CacheControl\)\);else if\(a\.type===([\w$]+)\.Raw\.ChatCompletionContentPartKind\.Opaque\)\{let s=([\w$]+)\(a\);/,
                    replacement: (_m: string, rawNs: string, lmData: string) =>
                        `else if(a.type===${rawNs}.Raw.ChatCompletionContentPartKind.Document){let dd=a.documentData,db=typeof dd.data=="string"?Buffer.from(dd.data,"base64"):Buffer.from(dd.data);o.push(new ${lmData}.LanguageModelDataPart(new Uint8Array(db),dd.mediaType||"application/pdf"))}${_m}`,
                },
            ],
            diagnosticProbes: [
                `ChatCompletionContentPartKind.CacheBreakpoint)e.emitCacheBreakpoints`,
                `o.push(new FA.LanguageModelDataPart(new Uint8Array(db),dd.mediaType`,
                `is.CacheControl));else if(a.type===UL.Raw.ChatCompletionContentPartKind.Opaque){let s=NEe(a)`,
            ],
            core: true,
        },
    ];
}
