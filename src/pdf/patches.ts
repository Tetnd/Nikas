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
                    find: `function kkn(n){return q_(n)||qj(n)||j3(n)}`,
                    replace: `function kkn(n){return q_(n)||qj(n)||j3(n)||(n.family||"").startsWith("deepseek")}`,
                },
            ],
            regexFallbacks: [
                {
                    // Symbol names of q_/qj/j3 may change; match the kkn shape generically.
                    pattern: /function (kkn|[\w$]{2})\(n\)\{return [\w$]+\(n\)\|\|[\w$]+\(n\)\|\|[\w$]+\(n\)\}/,
                    replacement: (m: string) => `${m}||(n.family||"").startsWith("deepseek")`,
                },
            ],
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
            ],
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
            ],
            // The gate is already correct (no supportsVision requirement) when the
            // PDF branch is gated only by `!kkn(<endpoint>)` — regardless of the
            // minified endpoint variable name. Without this, a bundle that already
            // has the patched form with a renamed endpoint (e.g. `!kkn(t)`) would be
            // falsely reported as "P4 missing" forever.
            //
            // The `[\s\S]*?` between the `.pdf$` test and the `if(!kkn(...))` gate
            // tolerates any instrumentation/statements injected between them (e.g.
            // a `__trace('B-PDF-ENTRY ...')` debug call seen on some builds). It
            // still does NOT match an unpatched gate, because that has
            // `!...supportsVision||!kkn(...)` — i.e. no `if(!kkn(` sequence.
            appliedRegexes: [
                /if\(\/\\\.pdf\$\/i\.test\(o\.path\)\)\{[\s\S]*?if\(!kkn\([\w$]+(?:\.[\w$]+)*\)\)\{/,
            ],
            replacements: [
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
                    // (this.promptEndpoint / t / e.model / etc.) may be renamed by
                    // minifiers, and the `supportsVision` check may appear before OR
                    // after the `kkn(...)` call. Matches the PDF gate with a
                    // `supportsVision` requirement and strips it, keeping the
                    // `kkn(...)` allowlist check (captured via its argument).
                    pattern: /if\(\/\\\.pdf\$\/i\.test\(o\.path\)\)\{if\((![\w$]+(?:\.[\w$]+)*\.supportsVision\|\|!kkn\(([\w$]+(?:\.[\w$]+)*)\)|!kkn\(([\w$]+(?:\.[\w$]+)*)\)\|\|![\w$]+(?:\.[\w$]+)*\.supportsVision)\)\{/,
                    replacement: (_m: string, _a: string, b: string | undefined, c: string | undefined) => {
                        const endpoint = b || c || 'this.promptEndpoint';
                        return `if(\/\\.pdf\$/i.test(o.path)){if(!kkn(${endpoint})){`;
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
                    find: `if(t.type===VD.ChatCompletionContentPartKind.Document)return;`,
                    replace: `if(t.type===VD.ChatCompletionContentPartKind.Document){let dd=t.documentData,db=typeof dd.data=="string"?Buffer.from(dd.data,"base64"):Buffer.from(dd.data);return new FA.LanguageModelDataPart(new Uint8Array(db),dd.mediaType||"application/pdf")}`,
                },
            ],
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
            description: 'Render PDF binary as a Lu.Document user message in the agent path',
            appliedMarkers: [
                `vscpp(Lu.Document,{data:d,mediaType:"application/pdf"})`,
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
            core: false,
        },

        // ── PATCH 8 — Include binary parts in the chat-variables filter ────
        {
            id: 'P8',
            description: 'Include binary chat variables in the forwarded set (s(v)||c(v))',
            appliedMarkers: [
                `filter(v=>s(v)||c(v)`,
            ],
            replacements: [
                {
                    // Current (2026-08) form: the binary filter `c` was dropped,
                    // leaving only text `s` OR reference `l`.
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
                    // Match a chatVariables filter that forwards only text (`s`)
                    // and OR in the binary check `c`.
                    pattern: /this\.props\.chatVariables\.filter\(v=>s\(v\)\)/,
                    replacement: `this.props.chatVariables.filter(v=>s(v)||c(v))`,
                },
            ],
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
