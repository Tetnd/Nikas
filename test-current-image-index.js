// Regression test for the vision "current image" detection fix.
//
// Mirrors the exact logic in src/vision/pipeline.ts:
//   - findCurrentImageMessageIndex  (returns the LAST user message with images)
//   - findCurrentPdfMessageIndex    (same, but for PDF parts)
//
// The bug: both functions bailed (returned undefined) as soon as they hit a
// trailing assistant message. In agent/continued conversations an assistant
// tool-call message ALWAYS follows the user's image message, so the newest
// images were never treated as "current" — never described, never cached
// (observed: `current=0 ... omitted=1` with `image/png` parts present).
//
// The fix: scan backward for the last image/PDF-bearing USER message without
// bailing on trailing assistant messages.

const ROLE = {
    User: 1,
    Assistant: 2,
    System: 3,
};

// LanguageModelImagePart shape (only what the index finder needs)
function img() {
    return { type: 'image', data: new Uint8Array(4) };
}
// LanguageModelTextPart shape
function txt(text) {
    return { type: 'text', value: text };
}
// PDF data part shape (non-binary, structured — only what the finder checks)
function pdf() {
    return { type: 'data', mime: 'application/pdf', data: new Uint8Array(4) };
}

function user(content) {
    return { role: ROLE.User, content };
}
function assistant(content) {
    return { role: ROLE.Assistant, content };
}

// ── Mirrors findCurrentImageMessageIndex (post-fix) ──
function findCurrentImageMessageIndex(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== ROLE.User) continue;
        const imageParts = (Array.isArray(message.content) ? message.content : [])
            .filter(p => p && p.type === 'image');
        if (imageParts.length > 0) return index;
    }
    return undefined;
}

// ── Mirrors findCurrentPdfMessageIndex (post-fix) ──
function findCurrentPdfMessageIndex(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== ROLE.User) continue;
        const pdfParts = (Array.isArray(message.content) ? message.content : [])
            .filter(p => p && p.type === 'data' && p.mime === 'application/pdf');
        if (pdfParts.length > 0) return index;
    }
    return undefined;
}

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
    const ok = actual === expected;
    if (ok) pass += 1;
    else fail += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (expected ${expected}, got ${actual})`);
}

// ── IMAGE cases ──

// 1. Single user message with image, nothing after it.
{
    const msgs = [user([txt('hi'), img()])];
    check('image: single user msg', findCurrentImageMessageIndex(msgs), 0);
}

// 2. THE BUG: user message with image followed by assistant message(s).
//    Pre-fix this returned undefined (current=0). Post-fix it must return the
//    user message index.
{
    const msgs = [
        user([txt('q1')]),
        assistant([txt('a1')]),
        user([txt('describe this'), img()]),
        assistant([txt('I will now call tools')]),
        assistant([txt('tool result')]),
    ];
    check('image: trailing assistant msgs (the bug)', findCurrentImageMessageIndex(msgs), 2);
}

// 3. Multiple image user messages — must return the LAST one, even with
//    assistant messages in between.
{
    const msgs = [
        user([txt('first'), img()]),
        assistant([txt('a1')]),
        user([txt('second'), img()]),
        assistant([txt('a2')]),
    ];
    check('image: multiple image turns returns last', findCurrentImageMessageIndex(msgs), 2);
}

// 4. Trailing assistant message with NO image user msg after it.
{
    const msgs = [user([txt('no image')]), assistant([txt('a')])];
    check('image: no image anywhere', findCurrentImageMessageIndex(msgs), undefined);
}

// 5. Image in the very last message (no trailing assistant) — still index.
{
    const msgs = [assistant([txt('a')]), user([txt('q'), img()])];
    check('image: image is last msg', findCurrentImageMessageIndex(msgs), 1);
}

// ── PDF cases ──

// 6. THE BUG for PDFs: user message with PDF followed by assistant messages.
{
    const msgs = [
        user([txt('q')]),
        assistant([txt('a')]),
        user([txt('read this'), pdf()]),
        assistant([txt('calling tool')]),
    ];
    check('pdf: trailing assistant msgs (the bug)', findCurrentPdfMessageIndex(msgs), 2);
}

// 7. Multiple PDF user messages — last wins.
{
    const msgs = [
        user([txt('one'), pdf()]),
        assistant([txt('a')]),
        user([txt('two'), pdf()]),
    ];
    check('pdf: multiple pdf turns returns last', findCurrentPdfMessageIndex(msgs), 2);
}

// 8. No PDFs anywhere.
{
    const msgs = [user([txt('no pdf')]), assistant([txt('a')])];
    check('pdf: no pdf anywhere', findCurrentPdfMessageIndex(msgs), undefined);
}

// ── Summary ──
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
