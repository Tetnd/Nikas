// Tests tool-result content conversion (src/transform/messages.ts
// buildToolResultMessages / toolResultPartToText) — how Copilot tool results
// (TextPart / PromptTsxPart / DataPart) become DeepSeek `tool` role strings.
// Run: node test-tool-results.js
let safe = 0;
let failures = 0;
function check(name, cond, detail) {
    if (cond) { safe++; console.log(`  PASS ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

// ── Mirrors of src/transform/messages.ts ──
// Stable VS Code part classes (verified in installed vscode.d.ts).
class LanguageModelTextPart { constructor(value) { this.value = value; } }
class LanguageModelPromptTsxPart { constructor(value) { this.value = value; } }
class LanguageModelDataPart { constructor(data, mimeType) { this.data = data; this.mimeType = mimeType; } }
class LanguageModelToolResultPart {
    constructor(callId, content, isError) { this.callId = callId; this.content = content; this.isError = isError ?? false; }
}

function toolResultPartToText(p) {
    if (p instanceof LanguageModelTextPart) {
        return p.value;
    }
    if (p instanceof LanguageModelPromptTsxPart) {
        try {
            const s = JSON.stringify(p.value, null, 2);
            return typeof s === 'string' ? s : '';
        } catch {
            return '[PromptTsxPart]';
        }
    }
    if (p instanceof LanguageModelDataPart) {
        if (p.mimeType.startsWith('image/')) {
            return `[image: ${p.mimeType}, ${p.data.byteLength} bytes]`;
        }
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(p.data);
        } catch {
            return `<decode error: ${p.data.byteLength} bytes>`;
        }
    }
    return '';
}

function buildToolResultMessages(parts) {
    const messages = [];
    for (const part of parts) {
        if (part instanceof LanguageModelToolResultPart) {
            const content = part.content
                .map(toolResultPartToText)
                .filter(s => s.length > 0)
                .join('\n');
            const isError = part.isError === true;
            const marked = isError
                ? (content ? `[tool error] ${content}` : '[tool error: no output]')
                : content;
            messages.push({ role: 'tool', tool_call_id: part.callId, content: marked || '' });
        } else if (part instanceof LanguageModelTextPart) {
            messages.push({ role: 'user', content: part.value });
        }
    }
    return messages;
}

const txt = (v) => new LanguageModelTextPart(v);
const tsx = (v) => new LanguageModelPromptTsxPart(v);
const img = (mime, bytes) => new LanguageModelDataPart(new Uint8Array(bytes), mime);
const bin = (mime, bytes) => new LanguageModelDataPart(new Uint8Array(bytes), mime);

console.log('\n=== 1. toolResultPartToText — part kinds ===');
check('TextPart → value', toolResultPartToText(txt('hello')) === 'hello');
const tsxVal = { type: 'element', name: 'read_file_result', props: { path: 'a.ts' }, children: ['line1', 'line2'] };
check('PromptTsxPart → pretty JSON (stringifies the value)', toolResultPartToText(tsx(tsxVal)) === JSON.stringify(tsxVal, null, 2));
check('PromptTsxPart nested is included', toolResultPartToText(tsx(tsxVal)).includes('"path": "a.ts"'));
check('PromptTsxPart circular value → fallback marker', toolResultPartToText(tsx((() => { const c = {}; c.self = c; return c; })())) === '[PromptTsxPart]');
check('image DataPart → lean placeholder (no giant base64)', toolResultPartToText(img('image/png', 4096)) === '[image: image/png, 4096 bytes]');
check('non-image DataPart → decoded text', toolResultPartToText(bin('application/json', new TextEncoder().encode('{"ok":true}'))) === '{"ok":true}');
check('non-image DataPart invalid utf8 → decode error marker', toolResultPartToText(bin('application/octet-stream', [0xff, 0xfe, 0xfd])) === '<decode error: 3 bytes>');
check('unknown part → empty string', toolResultPartToText({ kind: 'other' }) === '');

console.log('\n=== 2. buildToolResultMessages — realistic agent loop ===');
// A typical Copilot agent turn: read_file (PromptTsx), grep (PromptTsx),
// screenshot (image DataPart), plain text result.
const parts = [
    new LanguageModelToolResultPart('call-1', [tsx({ type: 'element', name: 'read_file_result', props: {}, children: ['const a = 1;'] })]),
    new LanguageModelToolResultPart('call-2', [txt('No matches found')]),
    new LanguageModelToolResultPart('call-3', [img('image/png', 1024)]),
    new LanguageModelToolResultPart('call-4', [bin('text/plain', new TextEncoder().encode('ok'))]),
];
const msgs = buildToolResultMessages(parts);
check('one tool message per ToolResultPart', msgs.length === 4);
check('all role=tool with matching call ids', msgs.every((m, i) => m.role === 'tool' && m.tool_call_id === `call-${i + 1}`));
check('PromptTsx content preserved (not dropped)', msgs[0].content.includes('const a = 1;'));
check('TextPart content preserved', msgs[1].content === 'No matches found');
check('image placeholder present', msgs[2].content === '[image: image/png, 1024 bytes]');
check('binary decoded', msgs[3].content === 'ok');

console.log('\n=== 3. edge cases ===');
check('empty result → empty string content (call id kept)', buildToolResultMessages([new LanguageModelToolResultPart('call-x', [])])[0].content === '');
check('PromptTsxPart undefined value → empty (no crash)', toolResultPartToText(tsx(undefined)) === '');
check('blank parts filtered out of content', buildToolResultMessages([new LanguageModelToolResultPart('call-y', [txt(''), txt('real'), tsx(undefined)])])[0].content === 'real');
check('non-tool text part in a tool message → user message', buildToolResultMessages([txt('side note')])[0].role === 'user');

console.log('\n=== 4. isError propagation (failed tools must not look like success) ===');
check('isError with content → prefixed marker', buildToolResultMessages([new LanguageModelToolResultPart('call-e1', [txt('Command failed: exit 2')], true)])[0].content === '[tool error] Command failed: exit 2');
check('isError with empty output → explicit no-output marker', buildToolResultMessages([new LanguageModelToolResultPart('call-e2', [] , true)])[0].content === '[tool error: no output]');
check('isError with prompt-tsx result → prefixed marker', buildToolResultMessages([new LanguageModelToolResultPart('call-e3', [tsx({ type: 'element', name: 'x', props: {}, children: ['boom'] })], true)])[0].content === '[tool error] ' + JSON.stringify({ type: 'element', name: 'x', props: {}, children: ['boom'] }, null, 2));
check('success (no isError) stays unmarked', buildToolResultMessages([new LanguageModelToolResultPart('call-ok', [txt('ok')])])[0].content === 'ok');

console.log(`\n${safe} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
