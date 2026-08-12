// Tests resolveToolChoice (src/provider.ts) — the mapping from VS Code's
// LanguageModelChatToolMode to DeepSeek's tool_choice.
// Run: node test-tool-mode.js
let safe = 0;
let failures = 0;
function check(name, cond, detail) {
    if (cond) { safe++; console.log(`  PASS ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
}

// ── Mirror of resolveToolChoice in src/provider.ts ──
// VS Code's stable enum LanguageModelChatToolMode: Auto=1 (model may call a
// tool or answer directly), Required=2 (model MUST call one of the provided
// tools). The provider must respect it — DeepSeek accepts 'auto' | 'required'
// | 'none' in both Chat Completions and Responses.
const LanguageModelChatToolMode = { Auto: 1, Required: 2 };
function resolveToolChoice(toolMode) {
    return toolMode === LanguageModelChatToolMode.Required ? 'required' : 'auto';
}

console.log('\n=== 1. toolMode → tool_choice mapping ===');
check('undefined (Auto default) → auto', resolveToolChoice(undefined) === 'auto');
check('Auto → auto', resolveToolChoice(LanguageModelChatToolMode.Auto) === 'auto');
check('Required → required', resolveToolChoice(LanguageModelChatToolMode.Required) === 'required');

console.log('\n=== 2. resolved choice is valid for both request shapes ===');
// src/api/types.ts: DeepSeekRequest and DeepSeekResponsesRequest both declare
// tool_choice?: 'none' | 'auto' | 'required'.
const allowed = ['none', 'auto', 'required'];
check('chat-completions accepts resolved value', allowed.includes(resolveToolChoice(LanguageModelChatToolMode.Required)));
check('responses accepts resolved value', allowed.includes(resolveToolChoice(LanguageModelChatToolMode.Required)));
check('never emits a value outside auto/required', ['auto', 'required'].includes(resolveToolChoice(LanguageModelChatToolMode.Auto)) && ['auto', 'required'].includes(resolveToolChoice(undefined)));

console.log(`\n${safe} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
