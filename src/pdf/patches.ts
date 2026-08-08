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
    /** Stable id (P1..P9) — matches the recipe's numbering. */
    id: string;
    description: string;
    /** If ANY of these strings is present, the patch is considered applied. */
    appliedMarkers: string[];
    /** Exact find/replace pairs; the first whose `find` occurs wins. */
    replacements: PatchReplacement[];
    /** Regex fallbacks tried only if no exact find matches (version drift). */
    regexFallbacks?: { pattern: RegExp; replacement: string | ((substring: string, ...args: any[]) => string) }[];
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
            core: true,
        },

        // ── PATCH 4 — Remove the supportsVision requirement on the PDF gate ─
        {
            id: 'P4',
            description: 'Remove the supportsVision requirement on the PDF gate',
            appliedMarkers: [
                `if(/\\.pdf$/i.test(o.path)){if(!kkn(this.promptEndpoint)){`,
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
            core: true,
        },

        // ── PATCH 5 — Convert Document raw parts to LanguageModelDataPart ──
        {
            id: 'P5',
            description: 'Convert Document content parts to LanguageModelDataPart (so Nikas receives the PDF)',
            appliedMarkers: [
                `LanguageModelDataPart(new Uint8Array(db)`,
            ],
            replacements: [
                {
                    find: `if(t.type===VD.ChatCompletionContentPartKind.Document)return;`,
                    replace: `if(t.type===VD.ChatCompletionContentPartKind.Document){let dd=t.documentData,db=typeof dd.data=="string"?Buffer.from(dd.data,"base64"):Buffer.from(dd.data);return new FA.LanguageModelDataPart(new Uint8Array(db),dd.mediaType||"application/pdf")}`,
                },
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
            core: false,
        },
    ];
}
