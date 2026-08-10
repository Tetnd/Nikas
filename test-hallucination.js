#!/usr/bin/env node
/**
 * test-hallucination.js — find the point where the model starts producing
 * bad code / hallucinating as the conversation fills the context window.
 *
 * WHY THIS EXISTS
 * ---------------
 * When a Copilot Chat session exceeds the Nikas context window
 * (nikas.contextWindow, e.g. 1M), the extension truncates the OLDEST
 * messages (see truncateMessagesToContextWindow in src/provider.ts). The
 * model then answers WITHOUT the early conversation — and it may either
 * admit ignorance or confidently FABRICATE facts / write plausible-but-wrong
 * code (hallucination).
 *
 * Two scenarios:
 *   --scenario=recall  (facts)  — embed N unguessable facts at the start,
 *                                 ask the model to recall them, grade
 *                                 CORRECT / UNSURE / HALLUCINATED.
 *   --scenario=code    (default)— embed fake project "conventions" (an
 *                                 internal API the model cannot know), fill
 *                                 the window, then ask it to WRITE CODE that
 *                                 must use those conventions. Grade contract
 *                                 compliance — the direct proxy for "bad
 *                                 code" (phantom utilities, wrong APIs).
 *
 * API mode (matches the extension's two DeepSeek paths):
 *   --api=chat       (default) — POST /chat/completions, model deepseek-v4-flash
 *   --api=responses            — POST /responses, model deepseek-v4-flash
 *                                (mirrors the extension's
 *                                deepseekMessagesToResponsesInput conversion
 *                                + Responses wire format)
 *
 * Thinking (matches the extension's buildThinkingParams /
 * buildResponsesThinkingParams):
 *   --thinking=off   (default) — thinking DISABLED (DeepSeek V4 defaults to
 *                                thinking ON when the param is absent, which
 *                                eats the whole output budget → empty replies.
 *                                The extension always sends the param, so we
 *                                must too, or we measure empty responses.)
 *   --thinking=low|high|max    — enable thinking; the harness sends the
 *                                configured max output as-is (boost removed
 *                                2026-08-09)
 *
 * USAGE
 * -----
 *   DEEPSEEK_API_KEY=... node test-hallucination.js --find-limit     # NEW LIMIT scan (code)
 *   DEEPSEEK_API_KEY=... node test-hallucination.js --api=responses  # via Responses API
 *   DEEPSEEK_API_KEY=... node test-hallucination.js                   # code scan, default fills
 *   DEEPSEEK_API_KEY=... node test-hallucination.js --scenario=recall
 *   node test-hallucination.js --dry                                 # truncation stats only, no API
 *   node test-hallucination.js --window=1000000 --max-output=8192    # match your settings
 *   node test-hallucination.js --fills=20,50,80,99 --tasks=3
 *   node test-hallucination.js --model=deepseek-v4-pro --threshold=80
 *
 * DEFAULT WINDOW: 1000000 (1M preset) — override with --window.
 * Baseline from the field (DeepSeek V4, 1M window, r/LocalLLaMA):
 *   solid < 150K, precision loss past ~300K, coding degrades 256-520K.
 * This harness measures YOUR number on YOUR model.
 */

const DEEPSEEK_API_BASE = 'https://api.deepseek.com';
const DEEPSEEK_CHAT_ENDPOINT = `${DEEPSEEK_API_BASE}/chat/completions`;
const DEEPSEEK_RESPONSES_ENDPOINT = `${DEEPSEEK_API_BASE}/responses`;

// ── Synthetic facts. Unique + unguessable so ANY confident wrong answer is
//    fabrication, and any "I don't know" is honest recall behavior. ──
const FACTS = [
    { q: 'What is the codename of the build pipeline in this project?', a: 'Project Cobalt Quill', probe: 'cobalt quill' },
    { q: 'What port does the internal metrics daemon listen on?', a: 'port 41731', probe: '41731' },
    { q: 'What is the name of the main integration test suite?', a: 'Zephyr Regression Suite', probe: 'zephyr regression' },
    { q: 'Who is the maintainer of the auth module?', a: 'Dana Voss', probe: 'dana voss' },
    { q: 'What database does the search service use?', a: 'TiKV cluster "north-star"', probe: 'north-star' },
    { q: 'What is the API version prefix for the billing endpoints?', a: 'v2026.4-beta', probe: 'v2026' },
    { q: 'What feature flag gates the new onboarding flow?', a: 'onboarding.react.ship', probe: 'onboarding' },
    { q: 'What is the max file size the upload service accepts?', a: '2.5 gigabytes', probe: '2.5' },
    { q: 'What is the SLO for the webhook delivery service?', a: '99.97 percent', probe: '99.97' },
    { q: 'What language is the legacy report generator written in?', a: 'Racket', probe: 'racket' },
    { q: 'What is the name of the CI badge service?', a: 'Cerulean Badger', probe: 'cerulean' },
    { q: 'What timezone do the cron jobs run in?', a: 'Asia/Jerusalem', probe: 'jerusalem' },
];

// ── Code conventions (for --scenario=code). A made-up internal API the model
//    cannot know. If its generated code uses these names, the conventions
//    survived the context fill. If it writes generic fetch/try-catch/
//    console.log/setTimeout instead, it forgot them — that is bad code. ──
const CODE_CONTRACTS = [
    {
        name: 'canonical client',
        rule: 'The canonical HTTP client is createClient("northstar") from "@acme/core". Always use it — never raw fetch().',
        probes: ['createclient', 'northstar'],
        antiProbes: ['fetch('],
    },
    {
        name: 'retry helper',
        rule: 'Every network call must be wrapped with withRetry(fn, { attempts: 5 }).',
        probes: ['withretry'],
        antiProbes: [],
    },
    {
        name: 'Result errors',
        rule: 'Error handling uses Result<T> — return .err()/.ok() (or check .isErr()). Never throw new Error().',
        probes: ['result<', '.err(', '.ok(', '.iserr('],
        antiProbes: ['throw new error'],
    },
    {
        name: 'timeout helper',
        rule: 'Waiting uses delay(ms) from "@acme/timers". setTimeout is banned.',
        probes: ['delay('],
        antiProbes: ['settimeout('],
    },
    {
        name: 'structured logging',
        rule: 'Logging uses the structured logger (logger.info/warn/error). console.log is banned.',
        probes: ['logger.'],
        antiProbes: ['console.log'],
    },
    {
        name: 'feature flag',
        rule: 'New behavior is gated behind flags.enabled("onboarding.react.ship").',
        probes: ['flags.enabled', 'onboarding.react.ship'],
        antiProbes: [],
    },
];

// Code tasks used at each probe. Both share the SAME conversation prefix, so
// DeepSeek prompt caching makes every task after the first cheap.
const CODE_TASKS = [
    'Write a TypeScript function `fetchUserProfile(userId: string): Promise<Result<UserProfile>>` for the billing-service. ' +
    'Follow the project conventions from the beginning of the conversation EXACTLY: create the client the canonical way (never raw fetch), ' +
    'wrap network calls in the retry helper, handle failures with the Result type (never throw), use the timeout helper instead of setTimeout, ' +
    'use the structured logger (never console.log), and gate the new behavior behind the feature flag. ' +
    'Return ONLY a single ```typescript code block, no explanations.',
    'Write a TypeScript function `sendWebhook(event: WebhookEvent): Promise<Result<void>>` for the webhook-worker. ' +
    'Follow the project conventions from the beginning of the conversation EXACTLY: create the client the canonical way (never raw fetch), ' +
    'wrap network calls in the retry helper, handle failures with the Result type (never throw), use the timeout helper instead of setTimeout, ' +
    'use the structured logger (never console.log), and gate the new behavior behind the feature flag. ' +
    'Return ONLY a single ```typescript code block, no explanations.',
];

// Filler vocabulary — deliberately disjoint from the fact answers above.
const MODULES = ['auth-service', 'billing-service', 'search-service', 'webhook-worker', 'report-generator', 'upload-service', 'metrics-daemon', 'onboarding-flow'];

// ═══════════════════════════════════════════════════════════════════════════
// --scenario=hard — REALLY hard code with OBJECTIVE, EXECUTABLE grading.
//
// The "code" scenario above grades convention compliance via substring probes
// (easy to satisfy and easy to fool). This scenario embeds a real project
// API contract + solved examples at the START of the conversation, fills the
// window with realistic agent churn, then asks the model to implement a HARD
// algorithm (LRU, A*, topo sort, regex DP, JSON parser, N-Queens, ...) that
// must conform to the early contract. Grading EXECUTES the generated code
// against unit tests in a fresh `node -e` subprocess — objective pass/fail,
// not substring matching. Degraded attention (lost-in-the-middle) or a
// forgotten contract → compile errors / failing tests → low score.
// ═══════════════════════════════════════════════════════════════════════════

/** Project API contract embedded at the START — first to be truncated. */
const HARD_PROJECT_CONTRACT =
    'PROJECT CONTRACT (this monorepo):\n' +
    '- Language: plain modern JavaScript (ES2020), Node 20. No imports, no require, no module.exports.\n' +
    '- Every task defines ONE top-level function (or class) with the EXACT name and signature given in the task.\n' +
    '- Functions are pure: no console.log, no global mutable state, no Math.random, no Date.\n' +
    '- Grids are arrays of rows; each row is an array of 0 (open) | 1 (blocked). Coordinates are [row, col].\n' +
    '- Edges are [from, to]; node ids are integers 0..n-1.\n' +
    '- When a task says "return X or null", null is the failure/absent case.\n' +
    '- Write ONLY the code. No explanations, no markdown fences, no "here is".';

/** Solved examples embedded alongside the contract (show the required style). */
const HARD_SOLVED_EXAMPLES = [
    {
        name: 'twoSum',
        user: 'PROJECT CONVENTION twoSum: given a 0-indexed array of integers and a target, return the indices of the two numbers that add up to target, or null if none.',
        assistant: '```js\nfunction twoSum(nums, target) {\n  const seen = new Map();\n  for (let i = 0; i < nums.length; i++) {\n    const need = target - nums[i];\n    if (seen.has(need)) return [seen.get(need), i];\n    seen.set(nums[i], i);\n  }\n  return null;\n}\n```',
    },
    {
        name: 'fib',
        user: 'PROJECT CONVENTION fib: return the n-th Fibonacci number (0-indexed, fib(0)=0, fib(1)=1), iteratively, no recursion.',
        assistant: '```js\nfunction fib(n) {\n  if (n <= 1) return n;\n  let a = 0, b = 1;\n  for (let i = 2; i <= n; i++) { const c = a + b; a = b; b = c; }\n  return b;\n}\n```',
    },
];

/**
 * Hard algorithmic tasks. Each carries the probe prompt + a JS test harness
 * that is concatenated with the model's answer and executed in a fresh
 * `node -e` subprocess. The harness calls the model's function with the exact
 * contract signature and asserts on behavior. Output contract: the harness
 * prints `JSON_R:{passed,total,failures:[...]}` as its last stdout line.
 */
const HARD_TASKS = [
    {
        id: 'lru',
        name: 'LRU Cache',
        spec:
            'Implement `class LRUCache { constructor(capacity); get(key); put(key, value); }` — an O(1) average least-recently-used cache. ' +
            'get returns the value or -1 when absent; put inserts and, when over capacity, evicts the least-recently-used entry; ' +
            'a get or put refreshes recency. Follow the PROJECT CONTRACT exactly (plain JS, one top-level class, no console.log). ' +
            'Write ONLY the code.',
        harness: `const __t = [];
(function () {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function t(name, cond) { __t.push(cond ? 1 : 0); if (!cond) __t.push(name); }
  try {
    const c = new LRUCache(2);
    c.put(1, 1); c.put(2, 2);
    t('get1', c.get(1) === 1);
    c.put(3, 3);                 // evicts 2
    t('get2 evicted', c.get(2) === -1);
    c.put(4, 4);                 // evicts 1
    t('get1 evicted', c.get(1) === -1);
    t('get3', c.get(3) === 3);
    t('get4', c.get(4) === 4);
    const d = new LRUCache(1);
    d.put(1, 10); d.put(2, 20);
    t('cap1 evict', d.get(1) === -1 && d.get(2) === 20);
    const e = new LRUCache(3);
    e.put(1, 1); e.put(2, 2); e.put(3, 3);
    e.get(1);                    // 1 is now most recent
    e.put(4, 4);                 // evicts 2 (least recent)
    t('refresh keeps 1', e.get(1) === 1 && e.get(2) === -1 && e.get(3) === 3 && e.get(4) === 4);
    t('missing', new LRUCache(5).get(99) === -1);
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'astar',
        name: 'A* shortest path',
        spec:
            'Implement `function shortestPath(grid, start, end)` — grid is rows of 0 (open) | 1 (blocked); start/end are [row, col]. ' +
            'Return the length of the shortest path (number of moves, up/down/left/right only), or -1 when unreachable; 0 when start === end. ' +
            'Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  try {
    const g1 = [[0,0,0],[0,0,0],[0,0,0]];
    t('open3x3', shortestPath(g1, [0,0], [2,2]) === 4);
    const g2 = [[0,0,0],[1,1,0],[0,0,0]];
    t('detour', shortestPath(g2, [0,0], [2,2]) === 4);
    const g3 = [[0,0],[0,1]];
    t('blocked', shortestPath(g3, [0,0], [1,1]) === -1);
    t('same', shortestPath(g3, [0,0], [0,0]) === 0);
    const g4 = [[0,0,0,0,0],[0,1,1,1,0],[0,0,0,0,0],[0,1,0,1,0],[0,0,0,0,0]];
    t('maze', shortestPath(g4, [0,0], [4,4]) === 8);
    const g5 = [[0,1],[0,0]];
    t('snake', shortestPath(g5, [0,0], [1,1]) === 2);
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'toposort',
        name: 'Topological sort + cycle detection',
        spec:
            'Implement `function topoSort(n, edges)` — n nodes 0..n-1; edges are [from, to] meaning from must come before to. ' +
            'Return an array that is a valid topological order of ALL n nodes, or null when a cycle exists. ' +
            'Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  const valid = (order, n, edges) => {
    if (!Array.isArray(order) || order.length !== n) return false;
    const pos = new Map(order.map((x, i) => [x, i]));
    if (order.some((x, i) => !Number.isInteger(x) || x < 0 || x >= n)) return false;
    if (new Set(order).size !== n) return false;
    return edges.every(([a, b]) => pos.get(a) < pos.get(b));
  };
  try {
    t('diamond', valid(topoSort(4, [[0,1],[0,2],[1,3],[2,3]]), 4, [[0,1],[0,2],[1,3],[2,3]]));
    t('chain', valid(topoSort(3, [[0,1],[1,2]]), 3, [[0,1],[1,2]]));
    t('cycle', topoSort(3, [[0,1],[1,2],[2,0]]) === null);
    t('selfloop', topoSort(2, [[0,0]]) === null);
    t('empty', valid(topoSort(3, []), 3, []));
    t('disconnected', valid(topoSort(5, [[0,1],[3,4]]), 5, [[0,1],[3,4]]));
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'editdist',
        name: 'Levenshtein edit distance',
        spec:
            'Implement `function editDistance(a, b)` — the minimum number of single-character insertions, deletions, or substitutions to turn a into b. ' +
            'Follow the PROJECT CONTRACT exactly (pure, no console.log). Write ONLY the code.',
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  try {
    t('empty-empty', editDistance('', '') === 0);
    t('equal', editDistance('abc', 'abc') === 0);
    t('kitten-sitting', editDistance('kitten', 'sitting') === 3);
    t('empty-b', editDistance('', 'abc') === 3);
    t('flaw-lawn', editDistance('flaw', 'lawn') === 2);
    t('intention-execution', editDistance('intention', 'execution') === 5);
    t('single', editDistance('a', 'b') === 1);
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'regexdp',
        name: 'Pattern matcher (. * + ?)',
        spec:
            'Implement `function matchPattern(s, p)` — regex subset matcher over the whole string. ' +
            'Support: `.` any single char; `*` zero or more of the preceding char; `+` one or more; `?` zero or one. ' +
            'Return boolean. Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  try {
    t('exact', matchPattern('aa', 'a') === false);
    t('star', matchPattern('aa', 'a*') === true);
    t('dotstar', matchPattern('ab', '.*') === true);
    t('c-star-a-star-b', matchPattern('aab', 'c*a*b') === true);
    t('mississippi', matchPattern('mississippi', 'mis*is*p*.') === false);
    t('plus', matchPattern('aaa', 'a+') === true);
    t('plus-needs-one', matchPattern('', 'a+') === false);
    t('question', matchPattern('a', 'a?') === true);
    t('question-empty', matchPattern('', 'a?') === true);
    t('question-combo', matchPattern('ab', 'a?b') === true);
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'jsonparse',
        name: 'JSON parser (subset)',
        spec:
            'Implement `function parseJSON(str)` — parse JSON supporting objects, arrays, strings (with \\\\" \\\\n \\\\t \\\\uXXXX escapes), ' +
            'numbers (int/float/negative/exponent), true/false/null. Throw an Error on ANY invalid input. ' +
            'Return the parsed value. Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ok = (s, want) => { try { t('valid:' + s.slice(0, 20), eq(parseJSON(s), want)); } catch (e) { t('valid:' + s.slice(0, 20), false); } };
  const bad = (s) => { try { parseJSON(s); t('invalid:' + s.slice(0, 20), false); } catch (e) { t('invalid:' + s.slice(0, 20), true); } };
  try {
    ok('{"a":1,"b":[true,false,null,"x\\\\ny",{"c":-2.5}]}', { a: 1, b: [true, false, null, 'x\\ny', { c: -2.5 }] });
    ok('[]', []);
    ok('{}', {});
    ok('  [1, 2, 3]  ', [1, 2, 3]);
    ok('"\\\\u0041"', 'A');
    ok('1.5e3', 1500);
    bad('{"a":}');
    bad('[1,]');
    bad('{"a" 1}');
    bad('abc');
    bad('{"a":1,}');
    bad('"{unclosed');
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'maxoverlap',
        name: 'Max interval overlap point',
        spec:
            'Implement `function maxOverlap(intervals)` — intervals is an array of [start, end] inclusive integer ranges. ' +
            'Return the SMALLEST point (integer) covered by the maximum number of intervals. ' +
            'Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  try {
    t('three-overlap', maxOverlap([[1,3],[2,4],[2,6]]) === 2);
    t('disjoint-tie-smallest', maxOverlap([[1,2],[3,4]]) === 1);
    t('single-point', maxOverlap([[0,10],[5,5]]) === 5);
    t('one', maxOverlap([[7,9]]) === 7);
    t('nested', maxOverlap([[1,10],[2,3],[4,5]]) === 2);
    t('negative', maxOverlap([[-5,5],[-2,2],[-1,1]]) === -1);
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'nqueens',
        name: 'N-Queens solver',
        spec:
            'Implement `function countNQueens(n)` — return the number of distinct ways to place n queens on an n×n board so no two attack each other. ' +
            'Follow the PROJECT CONTRACT exactly (pure function, no console.log). Write ONLY the code.',
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  try {
    t('n1', countNQueens(1) === 1);
    t('n2', countNQueens(2) === 0);
    t('n3', countNQueens(3) === 0);
    t('n4', countNQueens(4) === 2);
    t('n5', countNQueens(5) === 10);
    t('n6', countNQueens(6) === 4);
    t('n8', countNQueens(8) === 92);
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
];

// ═══════════════════════════════════════════════════════════════════════════
// --scenario=multiturn — MULTI-TURN consistency, the real "turning bad" test.
//
// The single-shot hard scenario can't reproduce the failure users actually
// see at 220-300K: the model applies MANY edits across turns and, as the
// session grows, drifts from the architecture established in the FIRST turns.
//
// This scenario embeds a users-service contract + solved example at the START,
// then TWO REAL endpoints already implemented (createUser, getUser) as prior
// work — genuine multi-turn history the model must stay consistent with. The
// window is then filled with realistic agent cycles, and a probe asks the
// model to implement ANOTHER endpoint (updateUser, deleteUser, listUsers,
// countUsers, findByEmail, touchUser) that MUST follow the same architecture:
// `(input, db)` injection, no imports, no throw, `{ok,data}` returns, and —
// for touchUser — use the injected `input.now`, never Date.now().
//
// Grading EXECUTES the generated code against a fake `db` in a fresh
// subprocess. Forgetting the early contract (importing db, throwing, wrong
// return shape, Date.now()) → failed tests → low score. The warmup endpoints
// are in the prompt, so a high-fill failure is DECISION DRIFT / lost-in-the-
// middle, not task hardness.
// ═══════════════════════════════════════════════════════════════════════════

/** The users-service architecture established in turn 1 — must survive to the probe. */
const MULTI_CONTRACT =
    'PROJECT CONTRACT (users-service):\n' +
    '- Language: plain modern JavaScript (ES2020), Node 20. No imports, no require, no module.exports.\n' +
    '- EVERY function has the exact signature `(input, db)` — db is injected, NEVER imported or required.\n' +
    '- Never throw. On failure return `{ ok: false, error: "..." }`; on success return `{ ok: true, data: ... }`.\n' +
    '- Validate `input` before touching db; missing/invalid input returns `{ ok: false, error: "invalid" }`.\n' +
    '- When a time is needed it is ALWAYS passed as `input.now` (ms) — never Date.now().\n' +
    '- Rows may have `deleted_at` (soft delete): treat `deleted_at !== null` as deleted (not found).\n' +
    '- The injected `db` object provides ONLY these methods:\n' +
    '    db.selectOne(table, where)  -> row | null\n' +
    '    db.insert(table, row)       -> { id }\n' +
    '    db.update(table, where, patch) -> updated row | null\n' +
    '    db.selectAll(table, where, opts) -> rows[] (opts may have { limit })\n' +
    '    db.count(table, where)      -> number\n' +
    '- Pick the method that matches what you need; there is no other db API.\n' +
    '- Write ONLY the code. No explanations, no markdown fences, no "here is".';

/** Small solved example showing the required style. */
const MULTI_SOLVED_EXAMPLE = {
    name: 'healthCheck',
    user: 'PROJECT CONVENTION healthCheck: return `{ ok: true, data: { status: "up" } }` without touching db.',
    assistant: '```js\nfunction healthCheck(input, db) {\n  return { ok: true, data: { status: "up" } };\n}\n```',
};

/**
 * Multi-turn endpoint tasks. Tasks 0-1 (createUser, getUser) are embedded in
 * the prompt as ALREADY-DONE prior work; the probe pool (MULTI_PROBE_TASKS)
 * is the rest. Each has a correct `reference` implementation (also used to
 * validate the harness) and a harness that enforces the shared contract.
 */
const MULTI_TASKS = [
    {
        id: 'createUser',
        name: 'createUser',
        spec:
            'Implement `function createUser(input, db)` for the users-service. input is `{ name, email }`. ' +
            'Validate first (invalid → `{ ok: false, error: "invalid" }`); a duplicate email → `{ ok: false, error: "duplicate" }`; ' +
            'otherwise insert and return `{ ok: true, data: { id, name, email } }`. Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        reference: `function createUser(input, db) {
  if (!input || typeof input.name !== 'string' || typeof input.email !== 'string') return { ok: false, error: 'invalid' };
  if (db.selectOne('users', { email: input.email })) return { ok: false, error: 'duplicate' };
  const { id } = db.insert('users', { name: input.name, email: input.email, deleted_at: null });
  return { ok: true, data: { id, name: input.name, email: input.email } };
}`,
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  const db = {
    _rows: [{ id: 1, name: 'alice', email: 'alice@x.io', deleted_at: null }],
    selectOne(tbl, where) { return this._rows.find(r => Object.keys(where).every(k => r[k] === where[k])) || null; },
    insert(tbl, row) { const id = this._rows.reduce((m, r) => Math.max(m, r.id), 0) + 1; this._rows.push({ ...row, id }); return { id }; },
  };
  try {
    const r1 = createUser({ name: 'dave', email: 'dave@x.io' }, db);
    t('ok shape', r1 && r1.ok === true && r1.data && Number.isInteger(r1.data.id));
    t('row stored', db.selectOne('users', { id: r1.data.id }) !== null);
    const r2 = createUser({ name: 'dupe', email: 'alice@x.io' }, db);
    t('duplicate', r2 && r2.ok === false && r2.error === 'duplicate');
    const r3 = createUser({ name: 'noemail' }, db);
    t('invalid', r3 && r3.ok === false);
    const r4 = createUser(null, db);
    t('null input', r4 && r4.ok === false);
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'getUser',
        name: 'getUser',
        spec:
            'Implement `function getUser(input, db)` for the users-service. input is `{ id }`. ' +
            'Return `{ ok: true, data: user }` when found and not soft-deleted; otherwise `{ ok: false, error: "not_found" }`. ' +
            'Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        reference: `function getUser(input, db) {
  if (!input || !Number.isInteger(input.id)) return { ok: false, error: 'invalid' };
  const row = db.selectOne('users', { id: input.id });
  if (!row || row.deleted_at !== null) return { ok: false, error: 'not_found' };
  return { ok: true, data: row };
}`,
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  const db = {
    _rows: [
      { id: 1, name: 'alice', email: 'alice@x.io', deleted_at: null },
      { id: 2, name: 'bob', email: 'bob@x.io', deleted_at: null },
      { id: 3, name: 'carol', email: 'carol@x.io', deleted_at: 1 },
    ],
    selectOne(tbl, where) { return this._rows.find(r => Object.keys(where).every(k => r[k] === where[k])) || null; },
  };
  try {
    const r1 = getUser({ id: 1 }, db);
    t('found', r1 && r1.ok === true && r1.data && r1.data.name === 'alice');
    const r2 = getUser({ id: 99 }, db);
    t('missing', r2 && r2.ok === false && r2.error === 'not_found');
    const r3 = getUser({ id: 3 }, db);
    t('soft-deleted', r3 && r3.ok === false && r3.error === 'not_found');
    const r4 = getUser({ id: 'x' }, db);
    t('invalid', r4 && r4.ok === false);
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'updateUser',
        name: 'updateUser',
        spec:
            'Implement `function updateUser(input, db)` for the users-service. input is `{ id, patch }`. ' +
            'Merge patch into the user and return `{ ok: true, data: updated }`; missing user → `{ ok: false, error: "not_found" }`. ' +
            'Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        reference: `function updateUser(input, db) {
  if (!input || !Number.isInteger(input.id) || !input.patch || typeof input.patch !== 'object') return { ok: false, error: 'invalid' };
  if (!db.selectOne('users', { id: input.id })) return { ok: false, error: 'not_found' };
  const updated = db.update('users', { id: input.id }, input.patch);
  return { ok: true, data: updated };
}`,
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  const db = {
    _rows: [{ id: 1, name: 'alice', email: 'alice@x.io', deleted_at: null }],
    selectOne(tbl, where) { return this._rows.find(r => Object.keys(where).every(k => r[k] === where[k])) || null; },
    update(tbl, where, patch) {
      const r = this._rows.find(x => Object.keys(where).every(k => x[k] === where[k]));
      if (!r) return null;
      Object.assign(r, patch);
      return { ...r };
    },
  };
  try {
    const r1 = updateUser({ id: 1, patch: { name: 'alicia' } }, db);
    t('updated', r1 && r1.ok === true && r1.data && r1.data.name === 'alicia');
    t('persisted', db.selectOne('users', { id: 1 }).name === 'alicia');
    const r2 = updateUser({ id: 99, patch: { name: 'x' } }, db);
    t('missing', r2 && r2.ok === false && r2.error === 'not_found');
    const r3 = updateUser({ id: 1 }, db);
    t('no patch', r3 && r3.ok === false);
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'deleteUser',
        name: 'deleteUser',
        spec:
            'Implement `function deleteUser(input, db)` for the users-service. input is `{ id }` — id ONLY, there is NO timestamp field, ' +
            'do NOT require or use input.now. Soft-delete (set `deleted_at` to a truthy value like 1), ' +
            'return `{ ok: true, data: { deleted: true } }`; missing user → `{ ok: false, error: "not_found" }`. ' +
            'Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        reference: `function deleteUser(input, db) {
  if (!input || !Number.isInteger(input.id)) return { ok: false, error: 'invalid' };
  if (!db.selectOne('users', { id: input.id })) return { ok: false, error: 'not_found' };
  db.update('users', { id: input.id }, { deleted_at: 1 });
  return { ok: true, data: { deleted: true } };
}`,
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  const db = {
    _rows: [{ id: 1, name: 'alice', email: 'alice@x.io', deleted_at: null }],
    selectOne(tbl, where) { return this._rows.find(r => Object.keys(where).every(k => r[k] === where[k])) || null; },
    update(tbl, where, patch) {
      const r = this._rows.find(x => Object.keys(where).every(k => x[k] === where[k]));
      if (!r) return null;
      Object.assign(r, patch);
      return { ...r };
    },
  };
  try {
    const r1 = deleteUser({ id: 1 }, db);
    t('deleted shape', r1 && r1.ok === true && r1.data && r1.data.deleted === true);
    t('soft flag set', db.selectOne('users', { id: 1 }).deleted_at !== null);
    const r2 = deleteUser({ id: 99 }, db);
    t('missing', r2 && r2.ok === false && r2.error === 'not_found');
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'listUsers',
        name: 'listUsers',
        spec:
            'Implement `function listUsers(input, db)` for the users-service. input is `{ limit }` (default 10). ' +
            'Return `{ ok: true, data: [users] }` — only NON-deleted users, at most `limit` of them. Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        reference: `function listUsers(input, db) {
  const limit = input && Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 10;
  const rows = db.selectAll('users', { deleted_at: null }, { limit });
  return { ok: true, data: rows };
}`,
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  const db = {
    _rows: [
      { id: 1, name: 'alice', email: 'a@x.io', deleted_at: null },
      { id: 2, name: 'bob', email: 'b@x.io', deleted_at: null },
      { id: 3, name: 'carol', email: 'c@x.io', deleted_at: 1 },
      { id: 4, name: 'dave', email: 'd@x.io', deleted_at: null },
    ],
    selectAll(tbl, where, opts) {
      let rows = this._rows.filter(r => Object.keys(where).every(k => r[k] === where[k]));
      if (opts && opts.limit) rows = rows.slice(0, opts.limit);
      return rows.map(r => ({ ...r }));
    },
  };
  try {
    const r1 = listUsers({ limit: 2 }, db);
    t('limited', r1 && r1.ok === true && Array.isArray(r1.data) && r1.data.length === 2);
    const r2 = listUsers({}, db);
    t('default limit', r2 && r2.ok === true && Array.isArray(r2.data) && r2.data.length === 3);
    t('excludes deleted', r2 && r2.data.every(u => u.deleted_at === null));
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'countUsers',
        name: 'countUsers',
        spec:
            'Implement `function countUsers(input, db)` for the users-service. Return `{ ok: true, data: { count } }` — the number of NON-deleted users. ' +
            'Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        reference: `function countUsers(input, db) {
  const n = db.count('users', { deleted_at: null });
  return { ok: true, data: { count: n } };
}`,
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  const db = {
    _rows: [
      { id: 1, name: 'alice', deleted_at: null },
      { id: 2, name: 'bob', deleted_at: null },
      { id: 3, name: 'carol', deleted_at: 1 },
    ],
    count(tbl, where) { return this._rows.filter(r => Object.keys(where).every(k => r[k] === where[k])).length; },
  };
  try {
    const r1 = countUsers({}, db);
    t('count non-deleted', r1 && r1.ok === true && r1.data && r1.data.count === 2);
    const r2 = countUsers(null, db);
    t('null input tolerated', r2 && r2.ok === true);
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'findByEmail',
        name: 'findByEmail',
        spec:
            'Implement `function findByEmail(input, db)` for the users-service. input is `{ email }`. ' +
            'Return `{ ok: true, data: user }` when a NON-deleted user has that email; otherwise `{ ok: false, error: "not_found" }`. ' +
            'Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        reference: `function findByEmail(input, db) {
  if (!input || typeof input.email !== 'string') return { ok: false, error: 'invalid' };
  const row = db.selectOne('users', { email: input.email });
  if (!row || row.deleted_at !== null) return { ok: false, error: 'not_found' };
  return { ok: true, data: row };
}`,
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  const db = {
    _rows: [
      { id: 1, name: 'alice', email: 'alice@x.io', deleted_at: null },
      { id: 3, name: 'carol', email: 'carol@x.io', deleted_at: 1 },
    ],
    selectOne(tbl, where) { return this._rows.find(r => Object.keys(where).every(k => r[k] === where[k])) || null; },
  };
  try {
    const r1 = findByEmail({ email: 'alice@x.io' }, db);
    t('found', r1 && r1.ok === true && r1.data && r1.data.name === 'alice');
    const r2 = findByEmail({ email: 'nobody@x.io' }, db);
    t('missing', r2 && r2.ok === false && r2.error === 'not_found');
    const r3 = findByEmail({ email: 'carol@x.io' }, db);
    t('soft-deleted', r3 && r3.ok === false && r3.error === 'not_found');
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
    {
        id: 'touchUser',
        name: 'touchUser',
        spec:
            'Implement `function touchUser(input, db)` for the users-service. input is `{ id, now }` — `now` is the current time in ms, ALWAYS passed in. ' +
            'Set `last_seen = now` and return `{ ok: true, data: updated }`; missing user → `{ ok: false, error: "not_found" }`. ' +
            'Use ONLY input.now — never Date.now(). Follow the PROJECT CONTRACT exactly. Write ONLY the code.',
        reference: `function touchUser(input, db) {
  if (!input || !Number.isInteger(input.id) || !Number.isInteger(input.now)) return { ok: false, error: 'invalid' };
  if (!db.selectOne('users', { id: input.id })) return { ok: false, error: 'not_found' };
  const updated = db.update('users', { id: input.id }, { last_seen: input.now });
  return { ok: true, data: updated };
}`,
        harness: `const __t = [];
(function () {
  const t = (n, c) => { __t.push(c ? 1 : 0); if (!c) __t.push(n); };
  const db = {
    _rows: [{ id: 1, name: 'alice', deleted_at: null, last_seen: 0 }],
    selectOne(tbl, where) { return this._rows.find(r => Object.keys(where).every(k => r[k] === where[k])) || null; },
    update(tbl, where, patch) {
      const r = this._rows.find(x => Object.keys(where).every(k => x[k] === where[k]));
      if (!r) return null;
      Object.assign(r, patch);
      return { ...r };
    },
  };
  try {
    const r1 = touchUser({ id: 1, now: 1000 }, db);
    t('uses injected now', r1 && r1.ok === true && r1.data && r1.data.last_seen === 1000);
    t('persisted', db.selectOne('users', { id: 1 }).last_seen === 1000);
    const r2 = touchUser({ id: 99, now: 1000 }, db);
    t('missing', r2 && r2.ok === false && r2.error === 'not_found');
    const r3 = touchUser({ id: 1 }, db);
    t('no now', r3 && r3.ok === false);
    t('no Date.now', !/Date\\.now/.test((touchUser + '')));
  } catch (err) { t('no-throw', false); }
})();
console.log('JSON_R:' + JSON.stringify({ passed: __t.filter(x => x === 1).length, total: __t.filter(x => x === 1 || x === 0).length, failures: __t.filter(x => typeof x === 'string') }));`,
    },
];

/** Probe pool = everything except the two warmup endpoints (already in the prompt). */
const MULTI_PROBE_TASKS = MULTI_TASKS.slice(2);

/** Build anchor messages for the multiturn scenario: contract + example + 2 real prior endpoints. */
function buildMultiAnchors() {
    const msgs = [];
    msgs.push({ role: 'user', content: `CONTRACT_0: ${MULTI_CONTRACT}` });
    msgs.push({ role: 'assistant', content: 'Understood — (input, db) everywhere, no imports, no throw, {ok, data} returns.' });
    msgs.push({ role: 'user', content: `CONTRACT_1: ${MULTI_SOLVED_EXAMPLE.user}` });
    msgs.push({ role: 'assistant', content: MULTI_SOLVED_EXAMPLE.assistant });
    // Real prior work — two endpoints already implemented earlier in the session.
    msgs.push({ role: 'user', content: MULTI_TASKS[0].spec });
    msgs.push({ role: 'assistant', content: '```js\n' + MULTI_TASKS[0].reference + '\n```' });
    msgs.push({ role: 'user', content: MULTI_TASKS[1].spec });
    msgs.push({ role: 'assistant', content: '```js\n' + MULTI_TASKS[1].reference + '\n```' });
    return msgs;
}

/** Index-style recap for multiturn compaction (verbatim architecture facts). */
function multiIndexRecap() {
    const L = [];
    L.push('# COMPACTED-SESSION INDEX (verbatim — lookup/grep these, do not paraphrase)');
    L.push('## lang');
    L.push('lang: plain ES2020 JavaScript, Node 20');
    L.push('imports: NONE — no import, no require, no module.exports');
    L.push('## signature');
    L.push('signature: every fn = (input, db); db INJECTED, never imported');
    L.push('returns: { ok:true, data } | { ok:false, error:"..." }; NEVER throw');
    L.push('validate: bad input -> { ok:false, error:"invalid" }');
    L.push('time: ALWAYS input.now (ms); NEVER Date.now()');
    L.push('soft-delete: deleted_at !== null -> treat as not_found');
    L.push('## db API (the ONLY methods; pick the one you need)');
    L.push('db.selectOne(table, where) -> row|null');
    L.push('db.insert(table, row) -> { id }');
    L.push('db.update(table, where, patch) -> updated row|null');
    L.push('db.selectAll(table, where, opts{limit}) -> rows[]');
    L.push('db.count(table, where) -> number');
    L.push('## prior endpoints (implemented, do not redefine)');
    L.push('createUser(input, db) -> { ok, data:{ id, name, email } } | duplicate | invalid');
    L.push('getUser(input, db) -> { ok, data:user } | not_found');
    L.push('healthCheck(input, db) -> { ok:true, data:{ status:"up" } }');
    return L.join('\n');
}

/** Fine-grained product-quality metrics for a generated answer (beyond pass/fail). */
function productMetrics(code) {
    return {
        codeLength: code.length,
        lineCount: code.split('\n').length,
        hasConsoleLog: /\bconsole\.(log|warn|error)\b/.test(code),
        hasDateNow: /\bDate\.now\(\)/.test(code),
        hasImport: /\b(import|require|module\.exports)\b/.test(code),
    };
}

const SYSTEM_PROMPT =
    'You are a meticulous senior engineer working in a large monorepo. ' +
    'The conversation begins with facts and project conventions marked FACT_n / CONTRACT_n. ' +
    'Answer strictly from the conversation above. ' +
    'If the conversation does not contain the requested information, say exactly ' +
    '"I do not have that information in the conversation." Never invent or guess. ' +
    'When asked to write code, follow the CONTRACT_n project conventions EXACTLY.';

// ── Mirror of src/provider.ts token estimate + truncation logic ──
// Content-aware estimator (prose/structured/base64 per-shape ratios) +
// adaptive calibration — mirrors src/provider.ts (2026-08-10).
const PROSE_CHARS_PER_TOKEN = 4.0;
const STRUCTURED_CHARS_PER_TOKEN = 2.5;
const BASE64_CHARS_PER_TOKEN = 1.4;
const STRUCTURED_PUNCT_THRESHOLD = 0.15;
const BASE64_RUN_RE = /[A-Za-z0-9+/=]{32,}/g;
const PUNCT_RE = /[^\p{L}\p{N}\s_]/gu;

let adaptiveCalibration = 1.1;
const ADAPTIVE_ALPHA = 0.25;
const ADAPTIVE_FLOOR = 0.8;
const ADAPTIVE_CEIL = 4.0;

function estimateSegmentTokens(segment) {
    if (!segment) return 0;
    const punctCount = (segment.match(PUNCT_RE) || []).length;
    const punctDensity = punctCount / segment.length;
    const charsPerToken = punctDensity >= STRUCTURED_PUNCT_THRESHOLD ? STRUCTURED_CHARS_PER_TOKEN : PROSE_CHARS_PER_TOKEN;
    return Math.ceil(segment.length / charsPerToken);
}

function estimateTextTokens(text) {
    if (!text) return 0;
    let total = 0;
    let last = 0;
    let m;
    BASE64_RUN_RE.lastIndex = 0;
    while ((m = BASE64_RUN_RE.exec(text)) !== null) {
        if (m.index > last) total += estimateSegmentTokens(text.slice(last, m.index));
        total += Math.ceil(m[0].length / BASE64_CHARS_PER_TOKEN);
        last = m.index + m[0].length;
    }
    if (last < text.length) total += estimateSegmentTokens(text.slice(last));
    return total;
}

function observeCalibration(realTokens, estimatedTokens) {
    if (!Number.isFinite(realTokens) || !Number.isFinite(estimatedTokens)) return;
    if (realTokens <= 0 || estimatedTokens <= 0) return;
    const ratio = realTokens / estimatedTokens;
    if (ratio <= 0 || ratio > 12) return;
    adaptiveCalibration = Math.min(ADAPTIVE_CEIL, Math.max(ADAPTIVE_FLOOR, ADAPTIVE_ALPHA * ratio + (1 - ADAPTIVE_ALPHA) * adaptiveCalibration));
}

function estimateMessageTokens(messages) {
    let total = 0;
    for (const msg of messages) {
        total += 8;
        if (typeof msg.content === 'string') {
            total += estimateTextTokens(msg.content);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text) total += estimateTextTokens(part.text);
                else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
                    const url = part.image_url.url;
                    const comma = url.indexOf(',');
                    const payload = comma >= 0 ? url.slice(comma + 1) : url;
                    total += estimateTextTokens(payload);
                }
            }
        }
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                total += estimateTextTokens(tc.function.name);
                total += estimateTextTokens(tc.function.arguments);
            }
        }
        if (msg.reasoning_content) total += estimateTextTokens(msg.reasoning_content);
    }
    return Math.ceil(total * adaptiveCalibration);
}

function repairTruncatedSequence(systemMessages, kept) {
    const result = [...kept];
    while (result.length > 0) {
        const last = result[result.length - 1];
        if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
            result.pop();
            continue;
        }
        if (last.role === 'tool') {
            const callerId = last.tool_call_id;
            const hasCaller = result.slice(0, -1).some(m =>
                m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === callerId)
            );
            if (!hasCaller) { result.pop(); continue; }
        }
        break;
    }
    while (result.length > 0 && result[0].role !== 'user') {
        result.shift();
    }
    return [...systemMessages, ...result];
}

function truncateMessagesToContextWindow(messages, maxContextTokens, maxOutputTokens) {
    const API_TOTAL_CEILING = 1048576;
    const API_CEILING_SAFETY = 65536;
    const availableInputTokens = Math.max(
        1024,
        Math.min(
            maxContextTokens - maxOutputTokens - 1024,
            API_TOTAL_CEILING - maxOutputTokens - API_CEILING_SAFETY
        )
    );
    const hardInputLimit = API_TOTAL_CEILING - maxOutputTokens - API_CEILING_SAFETY;
    const systemMessages = [];
    const otherMessages = [];
    for (const msg of messages) {
        if (msg.role === 'system' && systemMessages.length === 0) systemMessages.push(msg);
        else otherMessages.push(msg);
    }
    const estimatedTokens = estimateMessageTokens(messages);
    if (estimatedTokens <= availableInputTokens) {
        return repairTruncatedSequence(systemMessages, otherMessages);
    }
    const keptMessages = [];
    let tokenBudget = availableInputTokens - estimateMessageTokens(systemMessages);
    for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgTokens = estimateMessageTokens([msg]);
        if (msgTokens <= tokenBudget) {
            keptMessages.unshift(msg);
            tokenBudget -= msgTokens;
        } else if (keptMessages.length === 0) {
            // Oversized newest message — keep it (empty window is worse) unless
            // it exceeds the API's hard ceiling, plus caller + nearest user.
            if (msgTokens <= hardInputLimit) {
                keptMessages.unshift(msg);
                tokenBudget = 0;
                if (msg.role === 'tool' && msg.tool_call_id) {
                    const caller = otherMessages[i - 1];
                    if (caller && caller.role === 'assistant' && caller.tool_calls && caller.tool_calls.some(tc => tc.id === msg.tool_call_id)) {
                        keptMessages.unshift(caller);
                    }
                }
                const keptStart = otherMessages.length - keptMessages.length;
                for (let j = keptStart - 1; j >= 0; j--) {
                    if (otherMessages[j].role === 'user') { keptMessages.unshift(otherMessages[j]); break; }
                }
            } else {
                break;
            }
        } else {
            break;
        }
    }
    return repairTruncatedSequence(systemMessages, keptMessages);
}

// ── Conversation builder ──

/**
 * Realistic agent-cycle templates for the filler. Each is a function
 * (moduleA, moduleB, round) → a message sequence that looks like a REAL
 * agentic edit round: user reports a failing test → tool read → REAL file
 * content → assistant fix (real diff) → user asks to run tests → REAL test
 * runner output → assistant summary → next module.
 *
 * Real code in the filler matters, not noise: it costs realistic tokens and
 * competes for attention exactly like a real session's context does. This is
 * what lets the benchmark reproduce genuine "lost in the middle" behavior
 * instead of measuring a toy.
 */
const FILLER_CYCLES = [
    // Cycle A — TypeScript session TTL bug.
    (m1, m2, round) => ([
        { role: 'user', content:
`The integration test \`shouldRefreshTtl\` is failing in ${m1}:

    AssertionError: expected 5 to be 35
        at Object.<anonymous> (${m1}/test/session.test.ts:41:25)

Test file (${m1}/test/session.test.ts):

\`\`\`ts
import { touchSession } from '../src/session';

describe('touchSession', () => {
  it('refreshes a stale session', () => {
    const s = touchSession({ expiresAt: 10, lastSeen: 5 }, 20);
    expect(s.expiresAt).toBe(35); // now(20) + TTL(15)
    expect(s.lastSeen).toBe(20);
  });
});
\`\`\`

Fix the production code so the suite passes.` },
        { role: 'assistant', content: null, tool_calls: [{ id: `c${round}`, type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ path: `${m1}/src/session.ts` }) } }] },
        { role: 'tool', tool_call_id: `c${round}`, content:
`export interface Session { expiresAt: number; lastSeen: number; }

const TTL = 15;

export function touchSession(s: Session, now = Date.now()): Session {
  if (s.expiresAt < now) return s;
  return { ...s, lastSeen: now, expiresAt: now + TTL };
}` },
        { role: 'assistant', content:
`Bug: when the session is already stale we return it untouched, so the test sees lastSeen 5 and expiresAt 10. Fix: always refresh.

\`\`\`ts
export function touchSession(s: Session, now = Date.now()): Session {
  return { ...s, lastSeen: now, expiresAt: now + TTL };
}
\`\`\`` },
        { role: 'user', content: `Run the ${m1} suite.` },
        { role: 'assistant', content: null, tool_calls: [{ id: `c${round}b`, type: 'function', function: { name: 'runTests', arguments: JSON.stringify({ module: m1 }) } }] },
        { role: 'tool', tool_call_id: `c${round}b`, content:
`$ npx vitest run ${m1}
 ✓ ${m1}/test/session.test.ts (3 tests) 214ms
Test Files  1 passed (1)
      Tests  3 passed (3)` },
        { role: 'assistant', content: `${m1} suite green. Next: ${m2}.` },
    ]),

    // Cycle B — JavaScript off-by-one in chunk().
    (m1, m2, round) => ([
        { role: 'user', content:
`The unit test \`shouldChunkEvenly\` is failing in ${m1}:

    Expected: [ [ 1, 2 ], [ 3, 4 ], [ 5 ] ]
    Received: [ [ 1 ], [ 3 ], [ 5 ] ]
        at Object.<anonymous> (${m1}/test/chunk.test.js:18:21)

Test file (${m1}/test/chunk.test.js):

\`\`\`js
import { chunk } from '../src/chunk.js';

test('chunks an odd-length array', () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
});
\`\`\`

Fix the implementation.` },
        { role: 'assistant', content: null, tool_calls: [{ id: `c${round}`, type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ path: `${m1}/src/chunk.js` }) } }] },
        { role: 'tool', tool_call_id: `c${round}`, content:
`export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size - 1));
  }
  return out;
}` },
        { role: 'assistant', content:
`Off-by-one: \`slice(i, i + size - 1)\` drops one element per chunk. Should be \`i + size\`.

\`\`\`js
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
\`\`\`` },
        { role: 'user', content: `Run the ${m1} suite.` },
        { role: 'assistant', content: null, tool_calls: [{ id: `c${round}b`, type: 'function', function: { name: 'runTests', arguments: JSON.stringify({ module: m1 }) } }] },
        { role: 'tool', tool_call_id: `c${round}b`, content:
`$ node --test ${m1}
 ✓ ${m1}/test/chunk.test.js (2 tests) 96ms
ℹ tests 2 | pass 2 | fail 0` },
        { role: 'assistant', content: `${m1} tests pass now. Moving on to ${m2}.` },
    ]),

    // Cycle C — feature request: add a config field and wire it.
    (m1, m2, round) => ([
        { role: 'user', content:
`Add \`"maxRetries": 3\` to the ${m1} config and make the retry wrapper honor it instead of the hardcoded 2.` },
        { role: 'assistant', content: null, tool_calls: [{ id: `c${round}`, type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ path: `${m1}/src/config.json` }) } }] },
        { role: 'tool', tool_call_id: `c${round}`, content:
`{
  "timeoutMs": 5000,
  "maxRetries": 2,
  "backoffMs": 250
}` },
        { role: 'assistant', content: null, tool_calls: [{ id: `c${round}b`, type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ path: `${m1}/src/retry.js` }) } }] },
        { role: 'tool', tool_call_id: `c${round}b`, content:
`import config from './config.json';

export async function withRetry(fn) {
  let last;
  for (let i = 0; i <= 2; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(config.backoffMs); }
  }
  throw last;
}` },
        { role: 'assistant', content:
`Updated config and wired the loop bound to \`config.maxRetries\`.

\`\`\`json
{ "timeoutMs": 5000, "maxRetries": 3, "backoffMs": 250 }
\`\`\`

\`\`\`js
export async function withRetry(fn) {
  let last;
  for (let i = 0; i <= config.maxRetries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(config.backoffMs); }
  }
  throw last;
}
\`\`\`` },
        { role: 'user', content: `Run the ${m1} suite and lint.` },
        { role: 'assistant', content: null, tool_calls: [{ id: `c${round}c`, type: 'function', function: { name: 'runTests', arguments: JSON.stringify({ module: m1 }) } }] },
        { role: 'tool', tool_call_id: `c${round}c`, content:
`$ npx vitest run ${m1} && eslint ${m1}/src
 ✓ ${m1}/test/retry.test.ts (4 tests) 311ms
Test Files  1 passed (1)
      Tests  4 passed (4)` },
        { role: 'assistant', content: `${m1} config change landed, tests + lint green. Next: ${m2}.` },
    ]),
];

function buildConversation(fillPct, anchorMsgs, windowTokens, maxOutputTokens) {
    const availableInputTokens = Math.max(1024, windowTokens - maxOutputTokens - 1024);
    const system = { role: 'system', content: SYSTEM_PROMPT };

    // Anchors (facts or code conventions) go FIRST — oldest = first to be truncated.
    const factMsgs = anchorMsgs;

    const target = Math.floor((availableInputTokens * fillPct) / 100);
    const filler = [];
    let current = estimateMessageTokens([system, ...factMsgs]);
    let round = 0;

    // Pad with realistic agent-cycle rounds (user report → tool read → real
    // file content → fix → run tests → green → next module).
    while (current < target) {
        const m1 = MODULES[round % MODULES.length];
        const m2 = MODULES[(round + 1) % MODULES.length];
        const msgs = FILLER_CYCLES[round % FILLER_CYCLES.length](m1, m2, round);
        const add = estimateMessageTokens(msgs);
        // Stop near the target so we don't overshoot wildly (one partial round is fine).
        if (current + add > target && current >= target * 0.9) break;
        filler.push(...msgs);
        current += add;
        round++;
    }

    const messages = [system, ...factMsgs, ...filler];
    return { messages, availableInputTokens };
}

function survivingAnchorIndexes(messages, prefix) {
    const kept = new Set();
    const re = new RegExp(`^${prefix}_(\\d+):`);
    for (const m of messages) {
        if (m.role === 'user' && typeof m.content === 'string') {
            const m2 = re.exec(m.content);
            if (m2) kept.add(parseInt(m2[1], 10));
        }
    }
    return kept;
}

function buildAnchorMessages(anchors, prefix) {
    const msgs = [];
    anchors.forEach((a, i) => {
        msgs.push({ role: 'user', content: `${prefix}_${i}: ${a.user}` });
        msgs.push({ role: 'assistant', content: a.assistant });
    });
    return msgs;
}

// ── Answer grading ──
const UNSURE_PATTERNS = [
    /don'?t (know|have|recall)/i,
    /do not (know|have|recall)/i,
    /not (provided|mentioned|given|included|available|present)/i,
    /never (provided|mentioned|given|included|stated|discussed)/i,
    /no (information|mention|data|record|details|facts)/i,
    /can'?t (find|recall|remember|say|determine)/i,
    /cannot (find|recall|remember|say|determine)/i,
    /unable to (find|recall|remember|determine)/i,
    /wasn'?t (provided|mentioned|given|included)/i,
    /were not (provided|mentioned|given|included)/i,
    /isn'?t (in|part of)/i,
    /not part of/i,
    /not sure/i,
    /unknown/i,
    /not enough (information|context)/i,
    /no mention/i,
    /nothing (in|about)/i,
    /doesn'?t (appear|seem|look)/i,
    /didn'?t (provide|mention|include|state)/i,
    /i (have|was) (not|never) (given|told|provided)/i,
];

function gradeAnswer(answer, fact) {
    const a = (answer || '').toLowerCase();
    if (a.includes(fact.probe.toLowerCase())) return 'CORRECT';
    if (UNSURE_PATTERNS.some(re => re.test(a))) return 'UNSURE';
    return 'HALLUCINATED';
}

/**
 * Grade generated code against the contract list. Each contract is:
 *   satisfied — a required probe appeared in the code
 *   violated   — a forbidden anti-probe appeared (probe missing)
 *   neither    — the convention was simply omitted (also a failure)
 */
function gradeCode(answer, contracts) {
    const a = (answer || '').toLowerCase();
    return contracts.map((c, i) => ({
        idx: i,
        name: c.name,
        satisfied: c.probes.some(p => a.includes(p.toLowerCase())),
        violated: c.antiProbes.some(p => a.includes(p.toLowerCase())),
    }));
}

// ── Hard-code grading: EXECUTE the generated code against unit tests ──

/** Cap on a model answer we are willing to execute (chars). */
const HARD_CODE_MAX = 20000;
/** Fresh subprocess timeout for one test run (ms). */
const HARD_RUN_TIMEOUT = 20000;

/** Extract the first JavaScript code block (fenced or bare) from an answer. */
function extractCodeBlock(answer) {
    if (!answer) return '';
    const fence = /```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/i.exec(answer);
    if (fence) return fence[1].trim();
    // Bare block: if the whole answer looks like code (has function/class
    // keyword in the first 200 chars), use it as-is.
    if (/^(function|class|const|let|var)\b/.test(answer.trim()) || /^class\b/.test(answer.trim())) {
        return answer.trim();
    }
    return '';
}

/**
 * Run the model's code + task harness in a fresh `node -e` subprocess and
 * return { passed, total, failures, error }. Safe: real OS process with a
 * timeout, no access to this script's state, output capped.
 */
function runHardHarness(task, code) {
    if (!code || code.length > HARD_CODE_MAX) {
        return { passed: 0, total: 1, failures: ['no/extracted code'], error: 'no code extracted or too large' };
    }
    const script = `${code}\n\n${task.harness}`;
    let out;
    try {
        const { spawnSync } = require('child_process');
        const res = spawnSync(process.execPath, ['-e', script], {
            timeout: HARD_RUN_TIMEOUT,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            windowsHide: true,
        });
        if (res.error) {
            return { passed: 0, total: 1, failures: ['spawn error'], error: String(res.error.message || res.error) };
        }
        if (res.signal) {
            return { passed: 0, total: 1, failures: ['timeout/killed'], error: `killed by ${res.signal}` };
        }
        out = res.stdout || '';
        const stderr = (res.stderr || '').trim();
        // The REAL harness is always appended AFTER the model's code, so it is
        // the LAST JSON_R on stdout. The model's own answer may contain a
        // self-test JSON_R (copied from the anchor pattern) — that one runs
        // FIRST and must be ignored, or a self-reported wrong result shadows
        // the authoritative harness output.
        const ms = [...out.matchAll(/JSON_R:(\{[\s\S]*?\})/g)];
        const m = ms.length ? ms[ms.length - 1] : null;
        if (m) {
            try {
                const parsed = JSON.parse(m[1]);
                return {
                    passed: Number(parsed.passed) || 0,
                    total: Number(parsed.total) || 0,
                    failures: Array.isArray(parsed.failures) ? parsed.failures : [],
                    error: stderr ? stderr.slice(0, 300) : undefined,
                };
            } catch (e) {
                return { passed: 0, total: 1, failures: ['bad result'], error: `result parse: ${e.message}` };
            }
        }
        // No JSON_R marker → the model's code failed to compile/run.
        return { passed: 0, total: 1, failures: ['compile/run error'], error: (stderr || out).slice(0, 300) };
    } catch (err) {
        return { passed: 0, total: 1, failures: ['runner error'], error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Reasoning-quality analysis of a raw model answer. Detects the failure modes
 * that show up as long-context degradation even when the code still runs:
 *
 *   repetition   — % of the answer that is redundant: near-duplicate sentences
 *                  (Jaccard word-set overlap > 50%) OR repeated word bigrams
 *                  (the model "re-thinking the same idea" mid-sentence)
 *   codeBlocks   — fenced code blocks (multiple = redundant rewrites)
 *   outputTokens — rough estimate of the visible output size
 *   verbosity    — output size as % of the allowed budget
 *   truncated    — output hit ~95% of the allowed budget (rambled so much the
 *                  solution got cut off)
 *   spinScore    — 0..100 composite: repetition + truncation + redundant blocks
 */
function analyzeReasoning(answer, maxTokens) {
    if (!answer) {
        return { repetition: 0, codeBlocks: 0, outputTokens: 0, truncated: false, spinScore: 0, verbosity: 0 };
    }
    const text = answer;
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 0);
    const words = text.split(/\s+/).filter(Boolean);
    const outputTokens = Math.round(words.length * 1.3);

    // 1) Near-duplicate sentences (Jaccard on significant-word sets, >50%).
    let sentenceDupes = 0;
    const seen = [];
    for (const s of sentences) {
        const w = new Set(s.toLowerCase().split(/\W+/).filter(x => x.length > 2));
        if (w.size === 0) continue;
        let isDup = false;
        for (const prev of seen) {
            let inter = 0;
            for (const p of prev) if (w.has(p)) inter++;
            const union = prev.size + w.size - inter;
            if (union > 0 && inter / union > 0.5) { isDup = true; break; }
        }
        if (isDup) sentenceDupes++;
        seen.push(w);
    }
    const sentenceRep = sentences.length ? Math.round((sentenceDupes / sentences.length) * 100) : 0;

    // 2) Repeated word bigrams — loops the sentence-dupe check misses
    //    (same phrase recurring mid-sentence: "we need to ... we need to ...").
    //    Counts repeated OCCURRENCES (a phrase said 3× = 2 redundant repeats),
    //    so a fully looped answer approaches 100%.
    const sig = words.map(w => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(w => w.length > 2);
    const counts = new Map();
    for (let i = 0; i < sig.length - 1; i++) {
        const b = sig[i] + ' ' + sig[i + 1];
        counts.set(b, (counts.get(b) || 0) + 1);
    }
    let repeatedOccurrences = 0;
    for (const c of counts.values()) if (c > 1) repeatedOccurrences += c - 1;
    const bigramRep = sig.length > 1 ? Math.round((repeatedOccurrences / (sig.length - 1)) * 100) : 0;

    const repetition = Math.max(sentenceRep, bigramRep);
    const codeBlocks = Math.floor((text.match(/```/g) || []).length / 2);
    const truncated = maxTokens > 0 && outputTokens >= maxTokens * 0.95;
    const verbosity = maxTokens > 0 ? Math.min(100, Math.round((outputTokens / maxTokens) * 100)) : 0;
    const spinScore = Math.min(100, Math.round(
        repetition * 0.5 + (truncated ? 30 : 0) + (verbosity >= 90 ? 15 : 0) + Math.min(30, codeBlocks * 10)
    ));
    return { repetition, codeBlocks, outputTokens, truncated, spinScore, verbosity };
}

/**
 * Chain-of-thought QUALITY analysis (--reasoning-ab). Answers "is the
 * reasoning it does actually good, or is it spam?" by examining the raw
 * thinking-mode content, NOT the visible answer.
 *
 * Signals:
 *   chars/words      — raw size of the CoT (max burns FAR more than low)
 *   sentences        — how many separate thoughts it went through
 *   repetition       — % of sentences that are near-duplicates of an earlier
 *                      one (Jaccard word-overlap > 50%) — "re-thinking the
 *                      same idea"
 *   bigramRep        — repeated word-bigram ratio — mid-sentence loops
 *   hedging          — count of hedgy / second-guessing markers ("wait",
 *                      "actually", "let me reconsider", "hmm", "re-check",
 *                      "on second thought", "but", "maybe", "alternatively")
 *                      — signs of going back and forth instead of converging
 *   filler           — count of empty filler words ("here", "just", "simply",
 *                      "we need to", "basically", "ok", "so")
 *   codeMentions     — concrete progress: how many times it references actual
 *                      code/identifiers (function names, variables, arrays)
 *   spamScore        — 0..100 composite: repetition + hedging + filler
 *                      dominate; codeMentions REDUCE it (real progress).
 *                      ~0-25 good, 25-50 some fluff, 50+ spam/overthinking.
 */
function analyzeCot(cot) {
    if (!cot || !cot.trim()) {
        return { chars: 0, words: 0, sentences: 0, repetition: 0, bigramRep: 0, hedging: 0, filler: 0, codeMentions: 0, spamScore: 0, verdict: 'no reasoning' };
    }
    const text = cot.trim();
    const words = text.split(/\s+/).filter(Boolean);
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 0);

    // Near-duplicate sentences (same idea restated).
    let dupes = 0;
    const seen = [];
    for (const s of sentences) {
        const w = new Set(s.toLowerCase().split(/\W+/).filter(x => x.length > 2));
        if (w.size === 0) continue;
        let isDup = false;
        for (const prev of seen) {
            let inter = 0;
            for (const p of prev) if (w.has(p)) inter++;
            const union = prev.size + w.size - inter;
            if (union > 0 && inter / union > 0.5) { isDup = true; break; }
        }
        if (isDup) dupes++;
        seen.push(w);
    }
    const repetition = sentences.length ? Math.round((dupes / sentences.length) * 100) : 0;

    // Repeated word bigrams.
    const sig = words.map(w => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(w => w.length > 2);
    const counts = new Map();
    for (let i = 0; i < sig.length - 1; i++) {
        const b = sig[i] + ' ' + sig[i + 1];
        counts.set(b, (counts.get(b) || 0) + 1);
    }
    let repeatedOccurrences = 0;
    for (const c of counts.values()) if (c > 1) repeatedOccurrences += c - 1;
    const bigramRep = sig.length > 1 ? Math.round((repeatedOccurrences / (sig.length - 1)) * 100) : 0;

    // Hedging / second-guessing markers (going back and forth).
    const lower = text.toLowerCase();
    const hedging = (lower.match(/\b(wait|hmm|actually|alternatively|on second thought|let me reconsider|re-?check|re-?think|maybe|but wait|hold on|i wonder|not sure|should i|do i need)\b/g) || []).length;

    // Empty filler words (noise that pads the reasoning without progress).
    const filler = (lower.match(/\b(here|just|simply|basically|ok|okay|so basically|we need to|let me)\b/g) || []).length;

    // Concrete progress: references to code identifiers / data structures.
    const codeMentions = (text.match(/\b(function|class|const|let|var|return|array|object|map|set|queue|stack|loop|for|while|if|else|push|pop|index|length)\b/g) || []).length;

    // Composite: repetition & hedging are the core "overthinking the same
    // idea" signals; filler pads; real code progress offsets them.
    const spamScore = Math.min(100, Math.round(
        repetition * 0.8 +
        Math.min(40, hedging * 8) +
        Math.min(20, filler * 2) -
        Math.min(30, codeMentions * 1.5)
    ));
    const verdict = spamScore <= 25 ? 'good' : spamScore <= 50 ? 'fluff' : 'spam';
    return { chars: text.length, words: words.length, sentences: sentences.length, repetition, bigramRep, hedging, filler, codeMentions, spamScore, verdict };
}

/** Grade one hard task answer: compliance = tests passed / total. */
function gradeHardCode(answer, task, maxTokens) {
    const code = extractCodeBlock(answer);
    const r = runHardHarness(task, code);
    const compliance = r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
    return { ...r, compliance, code: code.slice(0, 200), product: productMetrics(code), reasoning: analyzeReasoning(answer, maxTokens) };
}

/** Build the anchor messages (contract + solved examples) for the hard scenario. */
function buildHardAnchors() {
    const msgs = [];
    msgs.push({ role: 'user', content: `CONTRACT_0: ${HARD_PROJECT_CONTRACT}` });
    msgs.push({ role: 'assistant', content: 'Understood — plain JS, exact signatures, pure functions, code only.' });
    HARD_SOLVED_EXAMPLES.forEach((ex, i) => {
        msgs.push({ role: 'user', content: `CONTRACT_${i + 1}: ${ex.user}` });
        msgs.push({ role: 'assistant', content: ex.assistant });
    });
    return msgs;
}

/** A realistic ideal summary of the hard anchors, for --compact-limit runs. */
function hardAnchorRecap() {
    const recap = [];
    recap.push(`CONTRACT_0: ${HARD_PROJECT_CONTRACT}`);
    for (const ex of HARD_SOLVED_EXAMPLES) recap.push(`${ex.name}: ${ex.user}`);
    return recap.join('\n');
}

/**
 * Index-style recap (--compact-style=index): a grep-friendly symbol index that
 * keeps identifiers, signatures and constraints VERBATIM instead of prose.
 * The "compaction index" idea — lossless names/signatures the model can look
 * up, at a fraction of the token cost of the full conversation. This is what
 * an ideal index-based compaction would inject.
 */
function hardIndexRecap() {
    const L = [];
    L.push('# COMPACTED-SESSION INDEX (verbatim — lookup/grep these, do not paraphrase)');
    L.push('## lang');
    L.push('lang: plain ES2020 JavaScript, Node 20');
    L.push('imports: NONE — no import, no require, no module.exports');
    L.push('## shape');
    L.push('shape: ONE top-level function|class; EXACT name+signature from the task');
    L.push('pure: no console.log | no global mutable state | no Math.random | no Date');
    L.push('grid: array of rows; row = array of 0(open)|1(blocked); coords [row, col]');
    L.push('edges: [from, to]; node ids int 0..n-1');
    L.push('absent: return null (or -1 when the task says so)');
    L.push('output: code ONLY — no explanations, no fences, no "here is"');
    L.push('## symbols');
    L.push('twoSum(nums, target) -> [i, j] | null');
    L.push('fib(n) -> n-th Fibonacci, 0-indexed: fib(0)=0, fib(1)=1; iterative, no recursion');
    return L.join('\n');
}

// ── DeepSeek API ──

/**
 * Convert chat-completions messages to Responses API input items.
 * Mirrors src/transform/messages.ts deepseekMessagesToResponsesInput:
 *   system → top-level `instructions` (first one) or `message` item
 *   user   → `message` item (role: user)
 *   assistant text → `message` item (role: assistant)
 *   assistant tool_calls → adjacent `function_call` items
 *   tool result → `function_call_output` item
 */
function messagesToResponsesInput(messages) {
    const input = [];
    let instructions;
    for (const msg of messages) {
        if (msg.role === 'system') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            if (!instructions && text) instructions = text;
            else input.push({ type: 'message', role: 'system', content: text });
            continue;
        }
        if (msg.role === 'user') {
            input.push({ type: 'message', role: 'user', content: typeof msg.content === 'string' ? msg.content : '' });
            continue;
        }
        if (msg.role === 'assistant') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            if (text) input.push({ type: 'message', role: 'assistant', content: text });
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    input.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    });
                }
            }
            continue;
        }
        if (msg.role === 'tool' && msg.tool_call_id) {
            input.push({
                type: 'function_call_output',
                call_id: msg.tool_call_id,
                output: typeof msg.content === 'string' ? msg.content : '',
            });
            continue;
        }
    }
    return { input, instructions };
}

/** Concatenate text from a Responses API response output array. */
function responsesText(output) {
    let text = '';
    for (const item of output || []) {
        if (item.type === 'message') {
            const content = item.content;
            if (typeof content === 'string') text += content;
            else if (Array.isArray(content)) {
                for (const part of content) {
                    if ((part.type === 'output_text' || part.type === 'input_text') && part.text) text += part.text;
                }
            }
        }
    }
    return text;
}

/**
 * Extract the thinking-mode chain-of-thought from a Responses API output
 * array. Mirrors src/api/deepseek.ts: reasoning can arrive as
 * `{ type: 'reasoning_text', text }` or `{ type: 'reasoning', summary }`
 * (summary can be a string or an array of summary_text parts). Observed
 * live (2026-08-11): deepseek-v4-flash returns
 * `{ type: 'reasoning', content: [{ type: 'reasoning_text', text }], summary: [] }`
 * — so also read `item.content` parts.
 */
function responsesReasoning(output) {
    let reasoning = '';
    const append = (s) => { if (s) reasoning += (reasoning ? '\n' : '') + s; };
    for (const item of output || []) {
        if (item.type === 'reasoning_text' && typeof item.text === 'string' && item.text) {
            append(item.text);
        } else if (item.type === 'reasoning') {
            const s = item.summary;
            if (typeof s === 'string' && s) append(s);
            else if (Array.isArray(s)) {
                for (const part of s) {
                    if (part && part.type === 'summary_text' && part.text) append(part.text);
                }
            }
            // Live DeepSeek shape: full CoT is in `content` as reasoning_text parts.
            const c = item.content;
            if (Array.isArray(c)) {
                for (const part of c) {
                    if (part && (part.type === 'reasoning_text' || part.type === 'output_text') && part.text) append(part.text);
                }
            }
        }
    }
    return reasoning.trim();
}

/**
 * Thinking params, mirroring the extension's buildThinkingParams
 * (chat-completions) and buildResponsesThinkingParams (responses).
 * CRITICAL: DeepSeek V4 enables thinking BY DEFAULT when the param is absent
 * and silently burns the entire output budget on reasoning tokens, returning
 * empty visible text. The extension always sends the param — so must we.
 */
function thinkingParamsFor(thinking, api) {
    if (thinking === 'off') {
        return api === 'responses' ? { reasoning: { effort: 'none' } } : { thinking: { type: 'disabled' } };
    }
    if (api === 'responses') return { reasoning: { effort: thinking } };
    return { thinking: { type: 'enabled' }, reasoning_effort: thinking };
}

/**
 * Output token budget, mirroring provider.ts (boost removed 2026-08-09):
 *   the configured maxTokens is sent as-is, thinking on or off.
 */
function outputBudgetFor(_thinking, baseMax) {
    return baseMax;
}

/**
 * Extract tool calls from a Responses API output array.
 * `function_call` items carry { call_id, name, arguments } (arguments JSON).
 */
function responsesToolCalls(output) {
    const calls = [];
    for (const item of output || []) {
        if (item.type === 'function_call' && item.name) {
            calls.push({ id: item.call_id, name: item.name, arguments: item.arguments || '' });
        }
    }
    return calls;
}

/**
 * One request WITH tools (Responses API) — mirrors provider.ts: sends the
 * flattened Responses tool shape + reasoning round-trip. Returns text, tool
 * calls, reasoning CoT, and usage. Does NOT loop — the caller feeds results
 * back.
 */
async function askWithTools(messages, key, model, maxTokens, thinking, tools) {
    const { input, instructions } = messagesToResponsesInput(messages);
    const body = {
        model: 'deepseek-v4-flash',
        input,
        stream: false,
        max_output_tokens: outputBudgetFor(thinking, maxTokens),
        temperature: 0,
        ...thinkingParamsFor(thinking, 'responses'),
        tools,
        tool_choice: 'auto',
    };
    if (instructions) body.instructions = instructions;
    const resp = await fetch(DEEPSEEK_RESPONSES_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`DeepSeek Responses tools API ${resp.status}: ${text.slice(0, 400)}`);
    }
    const data = await resp.json();
    return {
        text: responsesText(data.output || []).trim(),
        reasoning: responsesReasoning(data.output || []),
        toolCalls: responsesToolCalls(data.output || []),
        usage: data.usage,
    };
}

async function ask(messages, key, model, maxTokens = 256, api = 'chat', thinking = 'off') {
    if (api === 'responses') {
        const { input, instructions } = messagesToResponsesInput(messages);
        const body = {
            model: 'deepseek-v4-flash', // /responses only accepts flash
            input,
            stream: false,
            max_output_tokens: outputBudgetFor(thinking, maxTokens),
            temperature: 0,
            ...thinkingParamsFor(thinking, api),
        };
        if (instructions) body.instructions = instructions;
        const resp = await fetch(DEEPSEEK_RESPONSES_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`DeepSeek Responses API ${resp.status}: ${text.slice(0, 400)}`);
        }
        const data = await resp.json();
        return {
            text: responsesText(data.output || []).trim(),
            reasoning: responsesReasoning(data.output || []),
            usage: data.usage,
        };
    }

    const resp = await fetch(DEEPSEEK_CHAT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            max_tokens: outputBudgetFor(thinking, maxTokens),
            stream: false,
            ...thinkingParamsFor(thinking, api),
        }),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`DeepSeek API ${resp.status}: ${text.slice(0, 400)}`);
    }
    const data = await resp.json();
    return {
        text: data.choices?.[0]?.message?.content ?? '',
        reasoning: data.choices?.[0]?.message?.reasoning_content ?? '',
        usage: data.usage,
    };
}

// ── CLI parsing ──
function parseArgs(argv) {
    const opts = {
        key: process.env.DEEPSEEK_API_KEY,
        model: 'deepseek-v4-flash',
        window: 1000000,
        maxOutput: 8192,
        fills: null, // resolved per scenario in main()
        facts: FACTS.length,
        scenario: 'code',
        findLimit: false,
        tasksPerProbe: 2,
        threshold: 75,
        api: 'chat',
        thinking: 'off',
        compactLimit: 0,
        compactStyle: 'prose',
        hardTasks: 3,
        hardOffset: 0,
        maxOutputScan: null,
        setupScan: false,
        setupFill: 55,
        thinkingSweep: ['off', 'low', 'high'],
        maxOutputSweep: [4096, 16384, 32768],
        priceInMiss: DEFAULT_PRICES.inMiss,
        priceInHit: DEFAULT_PRICES.inHit,
        priceOut: DEFAULT_PRICES.out,
        productAb: null,
        reasoningAb: null,
        toolAb: null,
        toolCount: 52,
        diag: false,
        diagFill: 10,
        dry: false,
        json: false,
    };
    for (const a of argv) {
        if (a === '--dry') opts.dry = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--find-limit') opts.findLimit = true;
        else if (a === '--diag') opts.diag = true;
        else if (a.startsWith('--diag-fill=')) opts.diagFill = parseInt(a.slice(12), 10);
        else if (a.startsWith('--thinking=')) opts.thinking = a.slice(11);
        else if (a.startsWith('--key=')) opts.key = a.slice(6);
        else if (a.startsWith('--model=')) opts.model = a.slice(8);
        else if (a.startsWith('--window=')) opts.window = parseInt(a.slice(9), 10);
        else if (a.startsWith('--max-output=')) opts.maxOutput = parseInt(a.slice(13), 10);
        else if (a.startsWith('--fills=')) opts.fills = a.slice(8).split(',').map(Number).filter(n => !isNaN(n));
        else if (a.startsWith('--facts=')) opts.facts = parseInt(a.slice(8), 10);
        else if (a.startsWith('--scenario=')) opts.scenario = a.slice(11);
        else if (a.startsWith('--tasks=')) opts.tasksPerProbe = parseInt(a.slice(8), 10);
        else if (a.startsWith('--threshold=')) opts.threshold = parseInt(a.slice(12), 10);
        else if (a.startsWith('--api=')) opts.api = a.slice(6);
        else if (a.startsWith('--compact-limit=')) opts.compactLimit = parseInt(a.slice(16), 10);
        else if (a.startsWith('--compact-style=')) opts.compactStyle = a.slice(16);
        else if (a.startsWith('--hard-tasks=')) opts.hardTasks = parseInt(a.slice(13), 10);
        else if (a.startsWith('--hard-offset=')) opts.hardOffset = parseInt(a.slice(14), 10);
        else if (a.startsWith('--max-output-scan=')) opts.maxOutputScan = a.slice(18).split(',').map(Number).filter(n => !isNaN(n) && n > 0);
        else if (a === '--setup-scan') opts.setupScan = true;
        else if (a.startsWith('--product-ab=')) opts.productAb = a.slice(13).split(',').filter(x => ['off', 'low', 'high', 'max'].includes(x));
        else if (a.startsWith('--reasoning-ab=')) opts.reasoningAb = a.slice(15).split(',').filter(x => ['off', 'low', 'high', 'max'].includes(x));
        else if (a.startsWith('--tool-ab=')) opts.toolAb = a.slice(10).split(',').filter(x => ['off', 'low', 'high', 'max'].includes(x));
        else if (a.startsWith('--tools=')) opts.toolCount = parseInt(a.slice(8), 10);
        else if (a.startsWith('--setup-fill=')) opts.setupFill = parseInt(a.slice(13), 10);
        else if (a.startsWith('--thinking-sweep=')) opts.thinkingSweep = a.slice(17).split(',').filter(x => ['off', 'low', 'high', 'max'].includes(x));
        else if (a.startsWith('--max-output-sweep=')) opts.maxOutputSweep = a.slice(19).split(',').map(Number).filter(n => !isNaN(n) && n > 0);
        else if (a.startsWith('--price-in-miss=')) opts.priceInMiss = parseFloat(a.slice(16));
        else if (a.startsWith('--price-in-hit=')) opts.priceInHit = parseFloat(a.slice(15));
        else if (a.startsWith('--price-out=')) opts.priceOut = parseFloat(a.slice(12));
        else if (a === '--setup=ours') {
            // "Our setup": the user's real Nikas config —
            // Responses API (flash only), thinking low (default), 950K window, 16K output.
            opts.api = 'responses';
            opts.thinking = 'low';
            opts.window = 950000;
            opts.maxOutput = 16384;
        }
    }
    if (opts.api !== 'chat' && opts.api !== 'responses') {
        console.error(`ERROR: unknown --api=${opts.api} (use 'chat' or 'responses')`);
        process.exit(1);
    }
    if (!['off', 'low', 'high', 'max'].includes(opts.thinking)) {
        console.error(`ERROR: unknown --thinking=${opts.thinking} (use off|low|high|max)`);
        process.exit(1);
    }
    if (!opts.fills || opts.fills.length === 0) {
        if (opts.scenario === 'recall') opts.fills = [10, 25, 50, 75, 90, 95, 97, 99, 100, 102, 105];
        else if (opts.scenario === 'hard' || opts.scenario === 'multiturn') opts.fills = [10, 25, 40, 50, 60, 70, 80, 90, 99];
        else opts.fills = [10, 25, 40, 50, 60, 70, 80, 90, 99];
    }
    return opts;
}

const BAR = '─'.repeat(62);

// ── Main ──
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const isCode = opts.scenario === 'code';
    const isHard = opts.scenario === 'hard';
    const isMulti = opts.scenario === 'multiturn';
    const isRecall = opts.scenario === 'recall';
    const isHardLike = isHard || isMulti; // both use executable grading
    const prefix = isCode || isHardLike ? 'CONTRACT' : 'FACT';
    let anchors, anchorSpecs, anchorMsgs;
    if (isMulti) {
        anchors = [{ name: 'PROJECT_CONTRACT' }, { name: 'SOLVED_EXAMPLE' }];
        anchorSpecs = [];
        anchorMsgs = buildMultiAnchors();
    } else if (isHard) {
        // One entry per CONTRACT_ anchor message: the project contract + each solved example.
        anchors = [{ name: 'PROJECT_CONTRACT' }, ...HARD_SOLVED_EXAMPLES.map(ex => ({ name: ex.name }))];
        anchorSpecs = [];
        anchorMsgs = buildHardAnchors();
    } else if (isCode) {
        anchors = CODE_CONTRACTS;
        anchorSpecs = CODE_CONTRACTS.map(c => ({ user: `PROJECT CONVENTION ${c.name}: ${c.rule}`, assistant: `Understood — ${c.name} is ${c.rule}.` }));
        anchorMsgs = buildAnchorMessages(anchorSpecs, prefix);
    } else {
        anchors = FACTS.slice(0, opts.facts);
        anchorSpecs = FACTS.slice(0, opts.facts).map(f => ({ user: `${f.q} The answer is: ${f.a}. Remember this.`, assistant: `Noted — ${f.a}.` }));
        anchorMsgs = buildAnchorMessages(anchorSpecs, prefix);
    }
    const availableInputTokens = Math.max(1024, opts.window - opts.maxOutput - 1024);

    if (!opts.dry && !opts.key) {
        console.error('ERROR: no API key. Set DEEPSEEK_API_KEY env var or pass --key=sk-...');
        process.exit(1);
    }
    if (opts.findLimit && !isCode && !isHardLike) {
        console.error('ERROR: --find-limit requires --scenario=code, --scenario=hard or --scenario=multiturn (it measures code-quality degradation).');
        process.exit(1);
    }

    console.log(`Model: ${opts.model}  (API: /${opts.api === 'responses' ? 'responses' : 'chat/completions'})`);
    console.log(`Scenario: ${isMulti ? 'multiturn (MULTI-TURN consistency — prior endpoints in context must stay consistent across a long session, graded by execution)'
        : isHard ? 'hard (REAL algorithms, graded by EXECUTING the generated code against unit tests)'
        : isCode ? 'code (contract compliance — "bad code" proxy)'
        : 'recall (fact hallucination)'}`);
    console.log(`Thinking: ${opts.thinking}${opts.thinking === 'off' ? ' (disabled)' : ' (enabled)'}`);
    console.log(`Context window: ${opts.window.toLocaleString()} tokens | max output: ${opts.maxOutput.toLocaleString()} | available input: ~${availableInputTokens.toLocaleString()}`);
    if (opts.compactLimit > 0) {
        console.log(`Compaction: ON — reliability limit ${opts.compactLimit.toLocaleString()} tokens (oldest messages → session memory summary)`);
        if (isHardLike) {
            console.log(`Compaction style: ${opts.compactStyle === 'index' ? 'INDEX (grep-friendly symbol index, verbatim identifiers)' : 'PROSE (narrative summary)'}`);
        }
    } else {
        console.log(`Compaction: OFF (pure truncation)`);
    }
    if (isHardLike) {
        if (isMulti) {
            console.log(`Multi-turn pool: ${MULTI_TASKS.length} endpoint tasks; 2 (createUser, getUser) embedded as prior work; probe pool = ${MULTI_PROBE_TASKS.length}`);
            console.log(`Consistency contract: (input, db) injection | no imports | no throw | {ok,data} | input.now (never Date.now())`);
            console.log(`Grading: executes each answer against a fake db in a fresh subprocess; compliance = unit tests passed / total`);
        } else {
            console.log(`Hard tasks: ${HARD_TASKS.length} real algorithms (LRU, A*, topo sort, edit distance, regex DP, JSON parser, max overlap, N-Queens)`);
        }
        console.log(`Grading: executes each answer in a fresh node subprocess; compliance = unit tests passed / total`);
        const poolLen = isMulti ? MULTI_PROBE_TASKS.length : HARD_TASKS.length;
        console.log(`Per probe: ${opts.tasksPerProbe} task(s), rotating over a pool of ${poolLen}${isMulti ? ' endpoints' : ' algorithms'}`);
        console.log(`Fill levels: ${opts.fills.join('%, ')}% of available input  (break = compliance < ${opts.threshold}%)`);
    } else if (isCode) {
        console.log(`Contracts: ${CODE_CONTRACTS.length} fake project conventions at the START of the conversation`);
        console.log(`Fill levels: ${opts.fills.join('%, ')}% of available input  (break = compliance < ${opts.threshold}%)`);
    } else {
        console.log(`Facts: ${anchors.length} (embedded at the START of the conversation, first to be truncated)`);
        console.log(`Fill levels: ${opts.fills.join('%, ')}% of available input`);
    }
    if (opts.dry) console.log('[DRY RUN — truncation stats only, no API calls]');
    console.log('');

    if (opts.productAb && isHardLike) {
        await productAb(opts, anchorMsgs, availableInputTokens);
        return;
    }

    if (opts.reasoningAb && isHardLike) {
        await reasoningAb(opts, anchorMsgs, availableInputTokens);
        return;
    }

    if (opts.toolAb) {
        await toolAb(opts, anchorMsgs, availableInputTokens);
        return;
    }

    if (opts.maxOutputScan && isHardLike) {
        await scanMaxOutput(opts, anchorMsgs, availableInputTokens);
        return;
    }

    if (opts.setupScan) {
        if (!isHardLike) {
            console.error('ERROR: --setup-scan requires --scenario=hard or --scenario=multiturn (it grades real code by execution).');
            process.exit(1);
        }
        await scanSetup(opts, anchorMsgs, availableInputTokens);
        return;
    }

    if (opts.findLimit) {
        await findLimit(opts, anchorMsgs, availableInputTokens, isHardLike);
        return;
    }

    if (opts.diag) {
        await runDiag(opts, anchorMsgs, availableInputTokens, isHardLike);
        return;
    }

    await runScan(opts, anchors, anchorMsgs, availableInputTokens, isCode, isHardLike, prefix);
}

/**
 * DIAGNOSTIC MODE (--diag): print the RAW model output so we can see what it
 * actually writes before trusting the compliance numbers.
 *
 *   A) anchors only, no filler  — pure baseline (if compliance is ~0% HERE
 *      too, the test itself is the problem, not context length)
 *   B) one fill level (--diag-fill, default 10) — anchors buried under filler
 */
async function runDiag(opts, anchorMsgs, availableInputTokens, isHard) {
    const system = { role: 'system', content: SYSTEM_PROMPT };

    // A) baseline: anchors + task, nothing else (~3K tokens, full attention)
    const bare = [system, ...anchorMsgs];
    console.log(`[diag A] anchors only (~${estimateMessageTokens(bare).toLocaleString()} tok, ${bare.length} msgs) — baseline`);
    await diagProbe(opts, bare, isHard);

    // B) buried under filler at the requested fill level
    const { messages: raw } = buildConversation(opts.diagFill, anchorMsgs, opts.window, opts.maxOutput);
    const truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
    const contractsInPrompt = truncated.filter(m => m.role === 'user' && /^CONTRACT_/.test(m.content)).length;
    const anchorCount = anchorMsgs.filter(m => m.role === 'user' && /^CONTRACT_\d+:/.test(m.content)).length;
    console.log(`[diag B] fill ${opts.diagFill}% (~${estimateMessageTokens(truncated).toLocaleString()} tok, ${truncated.length} msgs) — anchors present: ${contractsInPrompt}/${anchorCount}`);
    await diagProbe(opts, truncated, isHard);
}

async function diagProbe(opts, prompt, isHard) {
    const p = [...prompt];
    if (p.length && p[p.length - 1].role === 'tool') {
        p.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
    }
    if (isHard) {
        const pool = opts.scenario === 'multiturn' ? MULTI_PROBE_TASKS : HARD_TASKS;
        const task = pool[opts.hardOffset % pool.length];
        p.push({ role: 'user', content: task.spec });
        const res = await ask(p, opts.key, opts.model, opts.maxOutput, opts.api, opts.thinking);
        const text = (res.text || '').trim();
        console.log('  --- RAW OUTPUT ---');
        console.log(text);
        console.log('  --- END RAW (length ' + text.length + ') ---');
        if (res.usage) console.log('  usage:', JSON.stringify(res.usage));
        const graded = gradeHardCode(text, task, opts.maxOutput);
        console.log(`  [${task.id}] compliance: ${graded.compliance}% (${graded.passed}/${graded.total} tests)`);
        const rz = graded.reasoning;
        if (rz) console.log(`    reasoning: ~${rz.outputTokens} out-tok | repetition ${rz.repetition}% | spin ${rz.spinScore}% | truncated ${rz.truncated} | code blocks ${rz.codeBlocks}`);
        if (graded.error) console.log(`    error: ${graded.error}`);
        console.log('');
        return;
    }
    p.push({ role: 'user', content: CODE_TASKS[0] });
    const res = await ask(p, opts.key, opts.model, 2000, opts.api, opts.thinking);
    const text = (res.text || '').trim();
    console.log('  --- RAW OUTPUT ---');
    console.log(text);
    console.log('  --- END RAW (length ' + text.length + ') ---');
    if (res.usage) console.log('  usage:', JSON.stringify(res.usage));
    const grades = gradeCode(text, CODE_CONTRACTS);
    const sat = grades.filter(g => g.satisfied).length;
    console.log(`  compliance: ${Math.round((sat / CODE_CONTRACTS.length) * 100)}% (${sat}/${CODE_CONTRACTS.length})`);
    grades.forEach(g => console.log(`    ${g.satisfied ? 'OK  ' : 'MISS'} ${g.name}${g.violated ? '  (VIOLATION: used forbidden pattern)' : ''}`));
    console.log('');
}

/**
 * Probe code quality at one fill level: build the conversation, apply the
 * extension's truncation, then ask `tasksPerProbe` code tasks and grade them
 * against the contracts. Returns mean compliance (%).
 */
async function probeCodeQuality(opts, anchorMsgs, availableInputTokens, fillPct) {
    const { messages: raw } = buildConversation(fillPct, anchorMsgs, opts.window, opts.maxOutput);
    const truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
    const prompt = [...truncated];
    if (prompt.length && prompt[prompt.length - 1].role === 'tool') {
        prompt.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
    }
    const results = [];
    for (let t = 0; t < opts.tasksPerProbe; t++) {
        const question = { role: 'user', content: CODE_TASKS[t % CODE_TASKS.length] };
        let answer = '', err = null;
        let usage;
        try {
            const res = await ask([...prompt, question], opts.key, opts.model, 1600, opts.api, opts.thinking);
            answer = (res.text || '').trim();
            usage = res.usage;
        } catch (e) {
            err = e instanceof Error ? e.message : String(e);
        }
        if (!answer && !err) {
            // Empty visible output — usually thinking mode ate the budget.
            const reason = usage?.output_tokens_details?.reasoning_tokens;
            console.warn(`  ⚠ EMPTY response (task ${t + 1}) — reasoning_tokens=${reason ?? 'n/a'}. ` +
                `If you did not pass --thinking=off, thinking is burning the output budget.`);
        }
        const grades = gradeCode(answer, CODE_CONTRACTS);
        const satisfied = grades.filter(g => g.satisfied).length;
        results.push({
            compliance: Math.round((satisfied / CODE_CONTRACTS.length) * 100),
            grades,
            answer,
            err,
            usage,
        });
    }
    const mean = Math.round(results.reduce((s, r) => s + r.compliance, 0) / results.length);
    const realInputTokens = results.reduce((mx, r) => Math.max(mx, r.usage?.input_tokens ?? 0), 0);
    return { fillPct, results, meanCompliance: mean, realInputTokens };
}

// ── Compaction mirror (--compact-limit=N) ──
// Mirrors maybeCompactContext in src/provider.ts, with the summary REPLACED
// by an ideal recap of the embedded anchors. This measures an UPPER BOUND on
// what compaction can buy: "if the session-memory summary preserved the early
// contract perfectly, does hard-code quality hold at high fill?" Real (lossy)
// summaries will be no better; if even this fails, compaction cannot rescue
// the workload.

function hardMessageText(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) return msg.content.filter(p => p.type === 'text' && p.text).map(p => p.text).join(' ');
    return '';
}

function hardEnsureUser(seq) {
    if (seq.some(m => m.role === 'user' && hardMessageText(m).trim() !== '')) return seq;
    return [{ role: 'user', content: 'Continue.' }, ...seq];
}

/**
 * Compact `messages` so the newest content fits under `limit`, replacing the
 * old block with the ideal anchor recap. Returns the original array when
 * compaction does not apply. Mirrors the provider's planning (snap to user,
 * merge summary into first kept user message, repair, ensure user).
 */
function compactConversation(messages, limit, anchorMsgs, style) {
    if (limit <= 0) return { messages, compacted: false };
    const estimated = estimateMessageTokens(messages);
    if (estimated <= limit) return { messages, compacted: false };

    const system = messages.length > 0 && messages[0].role === 'system' ? [messages[0]] : [];
    const others = messages.slice(system.length);

    const SUMMARY_MAX = 4096;
    let keepBudget = limit - estimateMessageTokens(system) - SUMMARY_MAX - 1024;
    if (keepBudget < 1024) return { messages, compacted: false };

    const keep = [];
    for (let i = others.length - 1; i >= 0; i--) {
        const t = estimateMessageTokens([others[i]]);
        if (t <= keepBudget) { keep.unshift(others[i]); keepBudget -= t; }
        else break;
    }

    let splitIdx = others.length - keep.length;
    if (keep.length > 0 && keep[0].role !== 'user') {
        let snapped = false;
        for (let j = splitIdx - 1; j >= 0; j--) {
            if (others[j].role === 'user') { keep.unshift(...others.slice(j, splitIdx)); splitIdx = j; snapped = true; break; }
        }
        if (!snapped) return { messages, compacted: false };
    }
    if (splitIdx <= 0) return { messages, compacted: false };

    const summaryText =
        `[Session memory — the earlier part of this conversation was compacted to keep ` +
        `the model reliable. Treat it as background context; it is NOT a new request.]\n\n` +
        (anchorMsgs && anchorMsgs.length
            ? (style === 'index' ? hardIndexRecap() : hardAnchorRecap())
            : 'Earlier work was summarized.');

    const keepCopy = keep.map(m => ({ ...m }));
    let head = [{ role: 'user', content: summaryText }];
    if (keepCopy.length > 0 && keepCopy[0].role === 'user') {
        const first = { ...keepCopy[0] };
        first.content = `${summaryText}\n\n---\n\n${hardMessageText(first)}`;
        keepCopy[0] = first;
        head = [];
    }

    const compacted = hardEnsureUser(repairTruncatedSequence(system, [...head, ...keepCopy]));
    return { messages: compacted, compacted: true };
}

/**
 * Probe HARD code quality at one fill level: build the conversation, apply
 * truncation (or compaction when --compact-limit is set), then ask
 * `tasksPerProbe` hard tasks and grade by EXECUTING the answers. Returns
 * mean compliance (tests passed / total).
 */
async function probeHardCode(opts, anchorMsgs, availableInputTokens, fillPct, maxTokens, thinking) {
    const outTokens = maxTokens || opts.maxOutput;
    const effThinking = thinking || opts.thinking;
    const { messages: raw } = buildConversation(fillPct, anchorMsgs, opts.window, opts.maxOutput);
    let truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
    let compacted = false;
    if (opts.compactLimit > 0) {
        const res = compactConversation(truncated, opts.compactLimit, anchorMsgs, opts.compactStyle);
        truncated = res.messages;
        compacted = res.compacted;
    }
    const prompt = [...truncated];
    if (prompt.length && prompt[prompt.length - 1].role === 'tool') {
        prompt.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
    }

    const results = [];
    const pool = opts.scenario === 'multiturn' ? MULTI_PROBE_TASKS : HARD_TASKS;
    for (let t = 0; t < opts.tasksPerProbe; t++) {
        const task = pool[(opts.hardOffset + t) % pool.length];
        const question = { role: 'user', content: task.spec };
        let answer = '', err = null, usage;
        try {
            const res = await ask([...prompt, question], opts.key, opts.model, outTokens, opts.api, effThinking);
            answer = (res.text || '').trim();
            usage = res.usage;
        } catch (e) {
            err = e instanceof Error ? e.message : String(e);
        }
        const graded = answer && !err
            ? gradeHardCode(answer, task, outTokens)
            : { passed: 0, total: 1, compliance: 0, failures: ['api error'], error: err, reasoning: analyzeReasoning(answer, outTokens), product: productMetrics('') };
        if (process.env.DEBUG_ANSWER && (graded.passed !== graded.total || graded.total !== (task.harness.match(/t\(/g) || []).length)) {
            console.log(`\n=== DEBUG ${task.id} fill=${fillPct} graded=${graded.passed}/${graded.total} ===`);
            console.log('--- RAW ANSWER ---');
            console.log(answer.slice(0, 3000));
            console.log('--- END RAW ANSWER ---');
        }
        results.push({ task: task.id, compliance: graded.compliance, passed: graded.passed, total: graded.total, answer, err, usage, error: graded.error, reasoning: graded.reasoning, product: graded.product });
    }
    const mean = Math.round(results.reduce((s, r) => s + r.compliance, 0) / results.length);
    const meanSpin = Math.round(results.reduce((s, r) => s + (r.reasoning?.spinScore || 0), 0) / results.length);
    const realInputTokens = results.reduce((mx, r) => Math.max(mx, r.usage?.input_tokens ?? 0), 0);
    return { fillPct, results, meanCompliance: mean, meanSpin, realInputTokens, compacted };
}

/**
 * Max-output scan (--max-output-scan=512,1024,...): keep the INPUT fill fixed
 * at --diag-fill (default 10%, so context length is NOT the variable) and vary
 * only the OUTPUT token budget, grading hard tasks by execution. A budget that
 * is too small cuts multi-function solutions off mid-code → compile errors →
 * low pass. This isolates "max output too small" from "context too long", and
 * shows how much headroom the user's maxOutput=16,384 setting actually needs.
 */
async function scanMaxOutput(opts, anchorMsgs, availableInputTokens) {
    const values = opts.maxOutputScan;
    const fillPct = opts.diagFill;
    console.log(`Scanning output budgets: ${values.join(', ')} tokens  (fixed input fill ${fillPct}%, ~${Math.round((availableInputTokens * fillPct) / 100).toLocaleString()} tok)`);
    console.log(`  Context is NOT the variable here — only how much output the model is allowed. ${opts.dry ? '[DRY — no API calls]' : ''}`);
    console.log('');

    if (opts.dry) {
        for (const mo of values) {
            console.log(`  max_output ${String(mo).padStart(6)}  (dry — would run ${opts.tasksPerProbe} hard task(s) with a ${mo}-token output budget)`);
        }
        console.log('');
        console.log('(dry) run without --dry to measure actual pass rates per output budget.');
        return;
    }

    for (const mo of values) {
        const probe = await probeHardCode(opts, anchorMsgs, availableInputTokens, fillPct, mo);
        const errs = probe.results.filter(r => r.err);
        if (errs.length === probe.results.length) {
            console.log(`  ⚠ max_output ${String(mo).padStart(6)}  API error(s): ${errs.map(r => r.err).join(' | ')}`);
            continue;
        }
        const truncated = probe.results.filter(r => r.reasoning && r.reasoning.truncated).length;
        const spun = probe.results.filter(r => r.reasoning && r.reasoning.spinScore >= 40);
        console.log(`  max_output ${String(mo).padStart(6)}  pass ${String(probe.meanCompliance).padStart(3)}%  spin ${String(probe.meanSpin).padStart(3)}%  truncated ${truncated}/${probe.results.length}  ` +
            probe.results.map(r => `${r.task}:${r.passed}/${r.total}${r.reasoning && r.reasoning.spinScore >= 40 ? '*' : ''}`).join(' '));
        if (truncated > 0) {
            console.log(`       ⚠ ${truncated} answer(s) hit the ${mo}-token budget — solutions cut off mid-code.`);
        }
        if (spun.length && truncated === 0) {
            console.log(`       ⚠ overthinking at this budget: ${spun.map(r => `${r.task} (rep ${r.reasoning.repetition}%)`).join(' | ')} — the model is re-writing instead of converging.`);
        }
    }
    console.log('');
    console.log('Interpretation:');
    console.log('  - pass collapses at small budgets → solutions are cut off mid-code (compile errors).');
    console.log('  - spin stays high even with a large budget → the model rambles/rethinks instead of writing.');
    console.log('  - your setup uses maxOutput 16,384 — the scan shows how much headroom you really need.');
}

// ── Product A/B (--product-ab=low,max) ──
// Runs the SAME tasks at the SAME context fill across thinking levels and
// prints the RAW outputs + product metrics side by side. Answers "does
// thinking=max produce a better product for the same prompt?" when pass% has
// saturated at 100% and no longer discriminates. Sweeps the whole probe pool
// at a realistic fill (--setup-fill, default 55% ≈ 500K) and ends with a
// summary table + verdict, so a single lucky/unlucky task can't decide.
async function productAb(opts, anchorMsgs, availableInputTokens) {
    const thinkings = opts.productAb;
    const fillPct = opts.setupFill;
    const pool = opts.scenario === 'multiturn' ? MULTI_PROBE_TASKS : HARD_TASKS;
    const maxTasks = Math.min(pool.length, opts.tasksPerProbe === 1 ? pool.length : 3);
    const tasks = pool.slice(0, maxTasks);

    const { messages: raw } = buildConversation(fillPct, anchorMsgs, opts.window, opts.maxOutput);
    const truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
    const base = [...truncated];
    if (base.length && base[base.length - 1].role === 'tool') {
        base.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
    }

    console.log(`Product A/B: ${maxTasks} task(s) at ${fillPct}% fill (~${Math.round((availableInputTokens * fillPct) / 100).toLocaleString()} tok) across thinking=${thinkings.join(',')}`);
    console.log(`Tasks: ${tasks.map(t => t.id).join(', ')}`);
    console.log('');
    if (opts.dry) {
        for (const th of thinkings) console.log(`  thinking=${th}  (dry — would print raw output + product metrics for ${maxTasks} task(s))`);
        return;
    }

    const summary = {}; // taskId -> { [thinking]: { pass, total, product, spin, reasonTok, outTok } }
    for (const task of tasks) {
        console.log(`════════════════ [${task.id}] ════════════════`);
        for (const th of thinkings) {
            const prompt = [...base, { role: 'user', content: task.spec }];
            let res;
            try {
                res = await ask(prompt, opts.key, opts.model, opts.maxOutput, opts.api, th);
            } catch (e) {
                console.log(`  thinking=${th}  API ERROR: ${e instanceof Error ? e.message : String(e)}`);
                continue;
            }
            const text = (res.text || '').trim();
            const graded = gradeHardCode(text, task, opts.maxOutput);
            const rz = graded.reasoning;
            const p = graded.product || {};
            const usage = res.usage || {};
            const reasonTok = usage.output_tokens_details?.reasoning_tokens || 0;
            console.log(`━━━ thinking=${th} ━━━`);
            console.log(text);
            console.log(`--- pass ${graded.compliance}% (${graded.passed}/${graded.total})  code ${p.codeLength} chars/${p.lineCount} lines  log ${p.hasConsoleLog}  Date.now ${p.hasDateNow}  import ${p.hasImport}  spin ${rz.spinScore}%  rep ${rz.repetition}%`);
            console.log(`    usage: in ${usage.input_tokens ?? 0} (cached ${usage.input_tokens_details?.cached_tokens || 0})  out ${usage.output_tokens ?? 0}  reasoning ${reasonTok}`);
            console.log('');
            if (!summary[task.id]) summary[task.id] = {};
            summary[task.id][th] = { pass: graded.compliance, total: graded.total, product: p, spin: rz.spinScore, reasonTok, outTok: usage.output_tokens || 0 };
        }
    }

    // ── Summary table ──
    console.log('');
    console.log('════════════════ SUMMARY: thinking low vs max on the SAME prompts ════════════════');
    const hdr = `${'task'.padEnd(12)}${thinkings.map(th => `${th.padEnd(10)}`).join('')}`;
    console.log(`${hdr}   (pass% / spin% / reason-tok / code-chars)`);
    for (const task of tasks) {
        const cells = thinkings.map(th => {
            const s = summary[task.id]?.[th];
            return s ? `${String(s.pass).padEnd(3)}% ${String(s.spin).padEnd(3)}% ${String(s.reasonTok).padEnd(4)} ${String(s.product.codeLength).padEnd(4)}` : 'ERR        ';
        }).join('  ');
        console.log(`${task.id.padEnd(12)}${cells}`);
    }
    // Aggregate across tasks.
    const agg = {};
    for (const th of thinkings) {
        const rows = Object.values(summary).map(s => s[th]).filter(Boolean);
        agg[th] = {
            pass: rows.length ? Math.round(rows.reduce((a, r) => a + r.pass, 0) / rows.length) : 0,
            spin: rows.length ? Math.round(rows.reduce((a, r) => a + r.spin, 0) / rows.length) : 0,
            reasonTok: rows.length ? Math.round(rows.reduce((a, r) => a + r.reasonTok, 0) / rows.length) : 0,
            outTok: rows.length ? Math.round(rows.reduce((a, r) => a + r.outTok, 0) / rows.length) : 0,
            code: rows.length ? Math.round(rows.reduce((a, r) => a + r.product.codeLength, 0) / rows.length) : 0,
        };
    }
    console.log('');
    console.log(`${'AVERAGE'.padEnd(12)}${thinkings.map(th => { const a = agg[th]; return `${String(a.pass).padEnd(3)}% ${String(a.spin).padEnd(3)}% ${String(a.reasonTok).padEnd(4)} ${String(a.code).padEnd(4)}`; }).join('  ')}`);
    console.log('');
    const better = (key, lowerIsBetter = true) => {
        const vals = thinkings.map(th => agg[th][key]);
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        return lowerIsBetter ? thinkings[vals.indexOf(min)] : thinkings[vals.indexOf(max)];
    };
    console.log(`Verdict (same prompt, only thinking changed):`);
    console.log(`  - best pass%:            ${better('pass', false)}  (${Math.max(...thinkings.map(th => agg[th].pass))}%)`);
    console.log(`  - lowest overthink spin: ${better('spin')}  (${Math.min(...thinkings.map(th => agg[th].spin))}%)`);
    console.log(`  - fewest reasoning tok:  ${better('reasonTok')}  (${Math.min(...thinkings.map(th => agg[th].reasonTok))} avg)`);
    console.log(`  - tightest code:         ${better('code')}  (${Math.min(...thinkings.map(th => agg[th].code))} chars avg)`);
    console.log('  Compare the RAW outputs above for yourself — same prompt, only the thinking level changed.');
}

// ── Reasoning A/B (--reasoning-ab=low,max) ──
// Answers the user's key question: "the reasoning it does — is it GOOD or is
// it SPAM?" by printing the ACTUAL chain-of-thought (thinking content) for
// each thinking level on the SAME task, then scoring it with analyzeCot
// (repetition / hedging / filler / code progress → spamScore 0..100).
// This is invisible in pass% and product metrics — max can pass 100% and
// still burn 5× the reasoning tokens on looping self-doubt. THIS mode shows
// the raw thinking so you can judge for yourself.
async function reasoningAb(opts, anchorMsgs, availableInputTokens) {
    const thinkings = opts.reasoningAb;
    const fillPct = opts.setupFill;
    const pool = opts.scenario === 'multiturn' ? MULTI_PROBE_TASKS : HARD_TASKS;
    const tasks = pool.slice(0, Math.min(pool.length, 2));

    const { messages: raw } = buildConversation(fillPct, anchorMsgs, opts.window, opts.maxOutput);
    const truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
    const base = [...truncated];
    if (base.length && base[base.length - 1].role === 'tool') {
        base.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
    }

    console.log(`Reasoning A/B: ${tasks.map(t => t.id).join(', ')} at ${fillPct}% fill (~${Math.round((availableInputTokens * fillPct) / 100).toLocaleString()} tok) across thinking=${thinkings.join(',')}`);
    console.log('Shows the RAW chain-of-thought per level and scores it: repetition / hedging / filler vs real code progress.');
    console.log('');
    if (opts.dry) {
        for (const th of thinkings) console.log(`  thinking=${th}  (dry — would print the full CoT + spam analysis)`);
        return;
    }

    const summary = {}; // taskId -> { [thinking]: cotAnalysis }
    for (const task of tasks) {
        console.log(`════════════════ [${task.id}] ════════════════`);
        for (const th of thinkings) {
            const prompt = [...base, { role: 'user', content: task.spec }];
            let res;
            try {
                res = await ask(prompt, opts.key, opts.model, opts.maxOutput, opts.api, th);
            } catch (e) {
                console.log(`  thinking=${th}  API ERROR: ${e instanceof Error ? e.message : String(e)}`);
                continue;
            }
            const text = (res.text || '').trim();
            const cot = (res.reasoning || '').trim();
            const graded = gradeHardCode(text, task, opts.maxOutput);
            const cotAnalysis = analyzeCot(cot);
            const usage = res.usage || {};
            const reasonTok = usage.output_tokens_details?.reasoning_tokens || 0;

            console.log(`━━━ thinking=${th}  (pass ${graded.compliance}%, reason-tok ${reasonTok}, CoT ${cotAnalysis.words} words) ━━━`);
            console.log(`  CoT spam score: ${cotAnalysis.spamScore}/100  → ${cotAnalysis.verdict.toUpperCase()}  (rep ${cotAnalysis.repetition}%, hedge ${cotAnalysis.hedging}, filler ${cotAnalysis.filler}, code-progress ${cotAnalysis.codeMentions})`);
            if (cot) {
                console.log('  ── raw chain-of-thought ──');
                console.log(cot);
                console.log('  ── end CoT ──');
            } else {
                console.log('  (no chain-of-thought returned)');
            }
            console.log('  ── visible answer (what you see) ──');
            console.log(text);
            console.log('');
            if (!summary[task.id]) summary[task.id] = {};
            summary[task.id][th] = cotAnalysis;
        }
    }

    console.log('════════════════ SUMMARY: reasoning quality low vs max ════════════════');
    console.log(`${'task'.padEnd(12)}${thinkings.map(th => `${th.padEnd(28)}`).join('')}`);
    console.log(`${''.padEnd(12)}${thinkings.map(th => `${'score/verdict (words, rep%, hedge, filler)'.padEnd(28)}`).join('')}`);
    for (const task of tasks) {
        const cells = thinkings.map(th => {
            const c = summary[task.id]?.[th];
            if (!c) return 'ERR'.padEnd(28);
            return `${String(c.spamScore).padEnd(3)}/100 ${c.verdict.padEnd(8)} (${String(c.words).padEnd(5)}w ${String(c.repetition).padEnd(3)}% ${String(c.hedging).padEnd(3)}h ${String(c.filler).padEnd(3)}f)`.slice(0, 28).padEnd(28);
        }).join('');
        console.log(`${task.id.padEnd(12)}${cells}`);
    }
    const agg = {};
    for (const th of thinkings) {
        const rows = Object.values(summary).map(s => s[th]).filter(Boolean);
        agg[th] = rows.length
            ? {
                spam: Math.round(rows.reduce((a, c) => a + c.spamScore, 0) / rows.length),
                words: Math.round(rows.reduce((a, c) => a + c.words, 0) / rows.length),
                rep: Math.round(rows.reduce((a, c) => a + c.repetition, 0) / rows.length),
                hedge: Math.round(rows.reduce((a, c) => a + c.hedging, 0) / rows.length),
                filler: Math.round(rows.reduce((a, c) => a + c.filler, 0) / rows.length),
            }
            : { spam: 0, words: 0, rep: 0, hedge: 0, filler: 0 };
    }
    console.log(`${'AVERAGE'.padEnd(12)}${thinkings.map(th => { const a = agg[th]; return `${String(a.spam).padEnd(3)}/100 ${(a.spam <= 25 ? 'good' : a.spam <= 50 ? 'fluff' : 'spam').padEnd(8)} (${String(a.words).padEnd(5)}w ${String(a.rep).padEnd(3)}% ${String(a.hedge).padEnd(3)}h ${String(a.filler).padEnd(3)}f)`.slice(0, 28).padEnd(28); }).join('')}`);
    console.log('');
    console.log('How to read it:');
    console.log('  - spamScore: repetition×0.8 + hedging×8 + filler×2 − code-progress×1.5 (0..100).');
    console.log('  - ≤25 good (converges, real progress), 25-50 fluff (some padding), 50+ spam (looping/overthinking).');
    console.log('  - Compare the RAW CoT above: is max actually reasoning deeper, or just saying the same thing more?');
    console.log('  - reason-tok = what max COSTS (bills as output). If the CoT is spam, you pay 5× for nothing.');
}

// ── Tool-loop A/B (--tool-ab=off,low,max) ──
// The FIRST benchmark that exercises REAL TOOL CALLING — the thing Copilot
// actually sends in an agentic session (edit, read, search, run). Everything
// else (find-limit, setup-scan, product-ab) measured single-shot codegen;
// this measures the loop: the model must call the right tool with the right
// args, react to tool results, converge — exactly the "does it work with all
// the tools Copilot sends" question.
//
// Scenario: a tiny fake repo with a planted bug. Tools: readFile / editFile /
// search / runTests. The model must use them to find and fix the bug and
// verify. Graded per thinking level: found the bug? fixed it? tests pass?
// turns to converge? how many useless turns (loop)? cost?

/**
 * Build the tool list for the tool-loop benchmark.
 *
 * Copilot Chat sends ~52 tools to the model in a real agentic session. With a
 * small list (4) the model trivially picks the right tool; with 52 it must
 * DISCOVER which ones actually apply — the real failure mode ("why did it call
 * the browser tool to fix my bug?"). This mirrors the real Copilot Chat tool
 * names + descriptions (read_file, grep_search, replace_string_in_file,
 * run_in_terminal, browser tools, GitHub, notebook, terminal, VS Code API,
 * memory, todo, etc.). Only the 4 file/terminal tools actually work against
 * the fake repo; the rest return a "not applicable here" style result so the
 * model can recover — but every wasted call is counted as a wrong-tool turn.
 *
 * `count` = how many tools to expose (default 52; pass a small number to
 * compare against the trivial 4-tool case). The 4 functional tools are always
 * FIRST so a small count still works.
 */
function buildCopilotTools(count) {
    const fn = (name, description, props, required) => ({
        type: 'function', name, description,
        parameters: { type: 'object', properties: props, required },
    });

    // The 4 tools that actually operate on the fake repo (kept first).
    const functional = [
        fn('read_file', 'Read a file from the workspace. Returns its full text content. Argument: filePath (absolute or workspace-relative path).',
            { filePath: { type: 'string' } }, ['filePath']),
        fn('grep_search', 'Search files in the workspace for a regex/string pattern. Returns matching lines with file paths. Arguments: query (pattern), isRegexp (bool).',
            { query: { type: 'string' }, isRegexp: { type: 'boolean' } }, ['query']),
        fn('replace_string_in_file', 'Replace an exact string in a file with new text. Arguments: filePath, oldString (exact match), newString (replacement). Returns ok or an error if oldString is not found.',
            { filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } }, ['filePath', 'oldString', 'newString']),
        fn('run_in_terminal', 'Run a shell command in the integrated terminal and return its output. Argument: command (shell command string).',
            { command: { type: 'string' } }, ['command']),
    ];

    // Realistic Copilot Chat companion tools (all return "not applicable to
    // this task / no such file" so the model can recover but wastes a turn).
    const distractors = [
        fn('create_file', 'Create a new file with the given content.', { filePath: { type: 'string' }, content: { type: 'string' } }, ['filePath']),
        fn('create_directory', 'Create a new directory.', { dirPath: { type: 'string' } }, ['dirPath']),
        fn('list_dir', 'List the contents of a directory.', { path: { type: 'string' } }, ['path']),
        fn('file_search', 'Search for files by glob pattern.', { query: { type: 'string' } }, ['query']),
        fn('multi_replace_string_in_file', 'Apply multiple string replacements across files in one call.', { explanation: { type: 'string' }, replacements: { type: 'array' } }, ['replacements']),
        fn('create_new_workspace', 'Scaffold a new complete project.', { query: { type: 'string' } }, ['query']),
        fn('create_new_jupyter_notebook', 'Create a new Jupyter notebook.', { query: { type: 'string' } }, ['query']),
        fn('edit_notebook_file', 'Edit a cell in a Jupyter notebook.', { filePath: { type: 'string' }, cellId: { type: 'string' } }, ['filePath']),
        fn('run_notebook_cell', 'Run a notebook cell.', { filePath: { type: 'string' }, cellId: { type: 'string' } }, ['filePath', 'cellId']),
        fn('run_task', 'Run a VS Code task.', { workspaceFolder: { type: 'string' }, id: { type: 'string' } }, ['workspaceFolder', 'id']),
        fn('create_and_run_task', 'Create and run a build/test task.', { workspaceFolder: { type: 'string' }, task: { type: 'object' } }, ['workspaceFolder']),
        fn('get_task_output', 'Get the output of a task.', { id: { type: 'string' }, workspaceFolder: { type: 'string' } }, ['id', 'workspaceFolder']),
        fn('send_to_terminal', 'Send input to an active terminal.', { id: { type: 'string' }, command: { type: 'string' } }, ['id', 'command']),
        fn('get_terminal_output', 'Get output from a terminal.', { id: { type: 'string' } }, ['id']),
        fn('kill_terminal', 'Kill a terminal.', { id: { type: 'string' } }, ['id']),
        fn('run_vscode_command', 'Execute a VS Code command.', { commandId: { type: 'string' }, name: { type: 'string' } }, ['commandId']),
        fn('install_extension', 'Install a VS Code extension.', { id: { type: 'string' }, name: { type: 'string' } }, ['id']),
        fn('get_errors', 'Get compile/lint errors in files.', { filePaths: { type: 'array' } }, []),
        fn('fetch_webpage', 'Fetch main content from a web page.', { urls: { type: 'array' }, query: { type: 'string' } }, ['urls']),
        fn('github_repo', 'Search a GitHub repository for code.', { repo: { type: 'string' }, query: { type: 'string' } }, ['repo', 'query']),
        fn('github_text_search', 'Lexically search a GitHub repo/org.', { scope: { type: 'string' }, query: { type: 'string' } }, ['scope', 'query']),
        fn('open_browser_page', 'Open a browser page at a URL.', { url: { type: 'string' } }, ['url']),
        fn('navigate_page', 'Navigate a browser page.', { pageId: { type: 'string' }, type: { type: 'string' } }, ['pageId']),
        fn('read_page', 'Get a snapshot of the current browser page.', { pageId: { type: 'string' } }, ['pageId']),
        fn('screenshot_page', 'Capture a screenshot of the browser page.', { pageId: { type: 'string' } }, ['pageId']),
        fn('click_element', 'Click an element on a browser page.', { pageId: { type: 'string' }, element: { type: 'string' } }, ['pageId', 'element']),
        fn('type_in_page', 'Type text into a browser page.', { pageId: { type: 'string' }, text: { type: 'string' } }, ['pageId', 'text']),
        fn('hover_element', 'Hover over an element on a page.', { pageId: { type: 'string' }, element: { type: 'string' } }, ['pageId', 'element']),
        fn('drag_element', 'Drag an element over another.', { pageId: { type: 'string' }, fromElement: { type: 'string' }, toElement: { type: 'string' } }, ['pageId']),
        fn('handle_dialog', 'Respond to a modal dialog on a page.', { pageId: { type: 'string' }, acceptModal: { type: 'boolean' } }, ['pageId']),
        fn('run_playwright_code', 'Run a Playwright snippet on a page.', { pageId: { type: 'string' }, code: { type: 'string' } }, ['pageId']),
        fn('vscode_askQuestions', 'Ask the user clarifying questions.', { questions: { type: 'array' } }, ['questions']),
        fn('vscode_listCodeUsages', 'Find usages of a code symbol.', { symbol: { type: 'string' }, lineContent: { type: 'string' } }, ['symbol']),
        fn('vscode_renameSymbol', 'Rename a code symbol.', { symbol: { type: 'string' }, newName: { type: 'string' } }, ['symbol', 'newName']),
        fn('vscode_searchExtensions_internal', 'Search the VS Code marketplace.', { category: { type: 'string' }, keywords: { type: 'array' } }, []),
        fn('get_vscode_api', 'Get VS Code API documentation.', { query: { type: 'string' } }, ['query']),
        fn('manage_todo_list', 'Manage a todo list.', { todoList: { type: 'array' } }, ['todoList']),
        fn('memory', 'Manage persistent memory notes.', { command: { type: 'string' }, path: { type: 'string' } }, ['command']),
        fn('resolve_memory_file_uri', 'Resolve a memory file path to a URI.', { path: { type: 'string' } }, ['path']),
        fn('session_store_sql', 'Query the local session store.', { action: { type: 'string' }, query: { type: 'string' } }, []),
        fn('terminal_selection', 'Get the current selection in the terminal.', {}, []),
        fn('terminal_last_command', 'Get the last command run in the terminal.', {}, []),
        fn('testFailure', 'Get details of test failures.', {}, []),
        fn('view_image', 'View the contents of an image file.', { filePath: { type: 'string' } }, ['filePath']),
        fn('read_notebook_cell_output', 'Read a notebook cell output.', { filePath: { type: 'string' }, cellId: { type: 'string' } }, ['filePath', 'cellId']),
        fn('copilot_getNotebookSummary', 'Get the summary of notebook cells.', { filePath: { type: 'string' } }, ['filePath']),
        fn('run_diagnostics', 'Run diagnostics on the current workspace.', {}, []),
        fn('explain_this', 'Explain the selected code or error.', { query: { type: 'string' } }, ['query']),
    ];

    const all = [...functional, ...distractors];
    return all.slice(0, Math.max(4, count || all.length));
}

async function toolAb(opts, anchorMsgs, availableInputTokens) {
    const thinkings = opts.toolAb;
    const fillPct = opts.setupFill;
    const useFiller = opts.setupFill > 0;

    console.log(`Tool-loop A/B: REAL agentic loop (read_file/grep_search/replace_string_in_file/run_in_terminal + ${(opts.toolCount || 52) - 4} distractor tools = ${opts.toolCount || 52} total) at ${useFiller ? fillPct + '% fill (~' + Math.round((availableInputTokens * fillPct) / 100).toLocaleString() + ' tok context)' : 'minimal context'} across thinking=${thinkings.join(',')}`);
    console.log('This measures TOOL CALLING — the model must call the right tool with the right args, react to results, and converge.');
    console.log('');
    if (opts.dry) {
        for (const th of thinkings) console.log(`  thinking=${th}  (dry — would run the full tool loop: find bug → edit → run tests → verify)`);
        return;
    }

    // ── Fake repo with a planted bug ──
    // The bug: subtract() computes b - a (wrong direction). priceDelta calls
    // subtract(end, start), so priceDelta(100,120) becomes -20 (want +20) and
    // priceDelta(120,100) becomes +20 (want -20) → the test GENUINELY fails
    // until subtract is fixed to a - b. Kept consistent with runTests below.
    const BUGGY_REPO = {
        'src/math.js': `// math helpers — do not change signatures
function add(a, b) { return a + b; }
// BUG: subtract returns b - a but callers expect a - b (price deltas)
function subtract(a, b) { return b - a; }
function multiply(a, b) { return a * b; }
function divide(a, b) { if (b === 0) return null; return a / b; }
module.exports = { add, subtract, multiply, divide };
`,
        'src/pricing.js': `// pricing uses subtract() to compute deltas
const { subtract } = require('./math.js');
// delta = end - start (positive when price rose)
function priceDelta(start, end) { return subtract(end, start); }
module.exports = { priceDelta };
`,
        'test/pricing.test.js': `// DO NOT EDIT THIS FILE
const assert = require('assert');
const { priceDelta } = require('../src/pricing.js');
assert.strictEqual(priceDelta(100, 120), 20, 'rise 100→120 should be +20');
assert.strictEqual(priceDelta(120, 100), -20, 'fall 120→100 should be -20');
console.log('ALL TESTS PASS');
`,
    };
    // A second, subtler bug in a different module — off is expected to miss
    // this one (it skips deep reasoning), low/max to catch it. Keeps the A/B
    // discriminating rather than all-equal. BUG_TASK asks for BOTH.
    const BUGGY_REPO_HARD = {
        ...BUGGY_REPO,
        'src/format.js': `// formatting helpers
// BUG: toString pads with '0' but callers expect a SPACE (' ') — invoice
// alignment breaks when numbers are zero-padded.
function pad2(n) { return String(n).padStart(2, '0'); }
module.exports = { pad2 };
`,
        'src/report.js': `const { pad2 } = require('./format.js');
// day must be right-aligned in a 2-wide column
function dayCell(day) { return pad2(day); }
module.exports = { dayCell };
`,
        'test/report.test.js': `// DO NOT EDIT THIS FILE
const assert = require('assert');
const { dayCell } = require('../src/report.js');
assert.strictEqual(dayCell(5), ' 5', 'day 5 should be space-padded');
assert.strictEqual(dayCell(15), '15', 'day 15 as-is');
console.log('ALL TESTS PASS');
`,
    };
    const BUG_TASK =
        'Two bugs are reported:\n' +
        '1) priceDelta(120, 100) returns 20 but it should be -20 (and priceDelta(100, 120) returns -20, should be +20).\n' +
        '2) dayCell(5) returns "05" but it should be " 5" (space-padded, not zero-padded).\n' +
        'Investigate with the tools, fix BOTH root causes (do NOT change any test/pricing.test.js or test/report.test.js), then run the tests to confirm.\n' +
        'When done, reply with a one-line summary of what you changed.';

    const tools = buildCopilotTools(opts.toolCount);

    // Build the conversation: anchors (contract) + optional filler + task.
    let messages;
    if (useFiller) {
        const { messages: raw } = buildConversation(fillPct, anchorMsgs, opts.window, opts.maxOutput);
        messages = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
    } else {
        messages = [...(anchorMsgs || [])];
    }
    if (messages.length && messages[messages.length - 1].role === 'tool') {
        messages.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
    }
    messages.push({ role: 'user', content: BUG_TASK });

    // In-memory repo state + tool executor. The executor takes the repo so
    // each thinking level gets a FRESH buggy copy (no state leakage).
    // Functional tools use the REAL Copilot names; everything else returns a
    // "not applicable / no such file" style result so the model can recover
    // but every call to a distractor is a wasted turn.
    const executeTool = (call, repo) => {
        let args = {};
        try { args = JSON.parse(call.arguments || '{}'); } catch (e) { return 'ERROR: tool arguments are not valid JSON.'; }
        if (call.name === 'read_file') {
            const p = args.filePath;
            if (repo[p] === undefined) return `ERROR: no such file '${p}'. Files: ${Object.keys(repo).join(', ')}`;
            return repo[p];
        }
        if (call.name === 'grep_search') {
            const q = String(args.query ?? '');
            const hits = [];
            for (const [p, content] of Object.entries(repo)) {
                const lines = content.split('\n');
                lines.forEach((ln, i) => { if (ln.includes(q)) hits.push(`${p}:${i + 1}: ${ln.trim()}`); });
            }
            return hits.length ? hits.join('\n') : `No matches for '${q}'`;
        }
        if (call.name === 'replace_string_in_file') {
            const p = args.filePath, find = String(args.oldString ?? ''), replace = String(args.newString ?? '');
            if (repo[p] === undefined) return `ERROR: no such file '${p}'. Files: ${Object.keys(repo).join(', ')}`;
            if (!find) return 'ERROR: replace_string_in_file requires a non-empty oldString.';
            const idx = repo[p].indexOf(find);
            if (idx === -1) return `ERROR: oldString not found in ${p}.`;
            repo[p] = repo[p].slice(0, idx) + replace + repo[p].slice(idx + find.length);
            return `OK: edited ${p}`;
        }
        if (call.name === 'run_in_terminal') {
            const cmd = String(args.command ?? '').toLowerCase();
            if (!cmd.includes('test') && !cmd.includes('node')) return `Command finished with exit code 0. (no output)`;
            // Mirror BOTH test files (pricing + report).
            const failures = [];
            const m = repo['src/math.js'];
            const sub = /function subtract\(a, b\) \{ return (.*?); \}/.exec(m);
            if (!sub) failures.push('subtract signature changed — do not change signatures');
            else {
                let body;
                try { body = new Function('a', 'b', 'return (' + sub[1] + ');'); } catch (e) { failures.push(`subtract body unparseable (${e.message})`); }
                if (body) {
                    const d1 = body(120, 100), d2 = body(100, 120);
                    if (d1 !== 20) failures.push(`subtract(120,100)=${d1} (want 20)`);
                    if (d2 !== -20) failures.push(`subtract(100,120)=${d2} (want -20)`);
                }
            }
            const f = repo['src/format.js'];
            const pad = /function pad2\(n\) \{ return (.*?); \}/.exec(f);
            if (!pad) failures.push('pad2 signature changed — do not change signatures');
            else {
                let pbody;
                try { pbody = new Function('n', 'return (' + pad[1] + ');'); } catch (e) { failures.push(`pad2 body unparseable (${e.message})`); }
                if (pbody) {
                    const p5 = pbody(5), p15 = pbody(15);
                    if (p5 !== ' 5') failures.push(`pad2(5)="${p5}" (want " 5")`);
                    if (p15 !== '15') failures.push(`pad2(15)="${p15}" (want "15")`);
                }
            }
            return failures.length ? `TESTS FAIL: ${failures.join(' | ')}` : 'ALL TESTS PASS';
        }
        // Distractor tool — not applicable to this task, but let the model
        // recover. A real agent would waste a turn here.
        const distractorReplies = {
            open_browser_page: 'Failed to load resource: no browser session is available for this workspace task.',
            fetch_webpage: 'Request failed with status code 404 — the URL is not relevant to the local codebase.',
            github_repo: 'No matching repository context for this workspace task.',
            run_vscode_command: 'Command not applicable: this task operates on workspace files, not editor UI.',
            install_extension: 'Extension already installed or not applicable to this task.',
            get_errors: 'No compile or lint errors reported in the current files.',
            manage_todo_list: 'Todo list updated (no effect on code).',
            memory: 'No memory notes relevant to this task were stored.',
            view_image: 'Not an image task — no image file path was provided.',
            create_file: 'Already exists or not needed for this task.',
        };
        if (distractorReplies[call.name]) return distractorReplies[call.name];
        return `Tool '${call.name}' executed with no effect on this task.`;
    };

    const results = [];
    for (const th of thinkings) {
        // FRESH repo per thinking level — otherwise the first level's edit
        // leaks into the next (a fixed repo makes later levels pass trivially).
        const repo = { ...BUGGY_REPO_HARD };
        const convo = messages.map(m => ({ ...m }));
        let turns = 0, useless = 0, reasonTok = 0, outTok = 0, cost = 0;
        let bug1Found = false, bug1Fixed = false, bug2Found = false, bug2Fixed = false, testsPass = false;
        const callsSeen = [];
        const MAX_TURNS = 12;
        let lastText = '';

        while (turns < MAX_TURNS) {
            turns++;
            let res;
            try {
                res = await askWithTools(convo, opts.key, opts.model, opts.maxOutput, th, tools);
            } catch (e) {
                console.log(`  thinking=${th}  API ERROR at turn ${turns}: ${e instanceof Error ? e.message : String(e)}`);
                break;
            }
            reasonTok += res.usage?.output_tokens_details?.reasoning_tokens || 0;
            outTok += res.usage?.output_tokens || 0;
            cost += estimateCost(res.usage, { inMiss: opts.priceInMiss, inHit: opts.priceInHit, out: opts.priceOut });

            if (!res.toolCalls || res.toolCalls.length === 0) {
                lastText = res.text;
                break; // final answer — loop done
            }

            // Execute each tool call, feed results back.
            const resultsMsgs = [];
            for (const call of res.toolCalls) {
                callsSeen.push(call.name);
                const out = executeTool(call, repo);
                if (call.name === 'grep_search') {
                    const q = (() => { try { return JSON.parse(call.arguments || '{}').query; } catch { return '?'; } })();
                    const ql = String(q).toLowerCase();
                    if (ql.includes('subtract') || ql.includes('price') || out.includes('src/math.js')) bug1Found = true;
                    if (ql.includes('pad') || ql.includes('day') || ql.includes('format') || out.includes('src/format.js')) bug2Found = true;
                }
                if (call.name === 'read_file') {
                    const p = String((() => { try { return JSON.parse(call.arguments || '{}').filePath; } catch { return ''; } })());
                    if (p.includes('src/math.js')) bug1Found = true;
                    if (p.includes('src/format.js')) bug2Found = true;
                }
                if (call.name === 'replace_string_in_file' && out.startsWith('OK')) {
                    const p = String((() => { try { return JSON.parse(call.arguments || '{}').filePath; } catch { return ''; } })());
                    if (p.includes('src/math.js')) bug1Fixed = true;
                    if (p.includes('src/format.js')) bug2Fixed = true;
                }
                if (call.name === 'run_in_terminal' && out.includes('ALL TESTS PASS')) testsPass = true;
                resultsMsgs.push({ role: 'tool', tool_call_id: call.id, content: out });
            }
            // Detect useless turns: no edit AND no test-run AND no real file
            // read/search — i.e. only distractor-tool calls (browser, github,
            // etc.) that don't move the task forward.
            const didWork = res.toolCalls.some(c =>
                c.name === 'replace_string_in_file' || c.name === 'run_in_terminal' ||
                c.name === 'read_file' || c.name === 'grep_search'
            );
            if (!didWork) useless++;
            convo.push({ role: 'assistant', content: null, tool_calls: res.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
            convo.push(...resultsMsgs);
        }

        // Final: confirm tests actually pass on the edited repo.
        const finalCheck = executeTool({ name: 'run_in_terminal', arguments: '{"command":"npm test"}' }, repo);
        const finalPass = finalCheck.includes('ALL TESTS PASS');
        const bugFound = bug1Found && bug2Found;
        const bugFixed = bug1Fixed && bug2Fixed;
        const wrongTools = callsSeen.filter(c => !['read_file', 'grep_search', 'replace_string_in_file', 'run_in_terminal'].includes(c)).length;
        results.push({ th, turns, useless, bugFound, bug1Fixed, bug2Fixed, finalPass, reasonTok, outTok, cost, callsSeen, lastText, wrongTools });
        console.log(`  thinking=${String(th).padEnd(4)} turns ${turns}  useless ${useless}  wrong-tool ${wrongTools}  bugs ${bug1Found && bug2Found ? 'both found' : bug1Found ? 'math only' : bug2Found ? 'format only' : 'none'}  edits ${bug1Fixed && bug2Fixed ? 'both' : bug1Fixed ? 'math' : bug2Fixed ? 'format' : 'none'}  tests ${finalPass ? '✓ PASS' : '✗ FAIL'}  reason ${reasonTok} tok  $${cost.toFixed(4)}`);
        console.log(`       calls: ${callsSeen.join(' → ') || '(none)'}`);
    }

    console.log('');
    console.log(BAR);
    console.log('TOOL-LOOP VERDICT (which thinking effort works best with Copilot\'s tools):');
    for (const r of results) {
        const ok = r.bugFound && r.bug1Fixed && r.bug2Fixed && r.finalPass;
        console.log(`  thinking=${String(r.th).padEnd(4)} → ${ok ? 'SUCCESS' : 'FAIL'}  (${r.turns} turns, ${r.useless} useless, ${r.wrongTools} wrong-tool calls, ${r.reasonTok} reason-tok, $${r.cost.toFixed(4)})`);
    }
    console.log(`  (exposed ${tools.length} tools: read_file / grep_search / replace_string_in_file / run_in_terminal + ${tools.length - 4} distractors)`);
    console.log('  - success = found both bugs, edited both, tests pass at the end.');
    console.log('  - turns = speed to converge (fewer is better). useless = turns with no file/test work.');
    console.log('  - wrong-tool = calls to browser/github/notebook/etc. tools instead of the 4 file tools.');
    console.log('  - reason-tok = thinking burn (bills as output). This is where max/high cost extra.');
    console.log('  - The extension REQUIRES reasoning round-trip with tools (else HTTP 400) — all levels above round-tripped.');
}

// ── Setup optimizer (--setup-scan) ──
// Sweeps THINKING × MAX-OUTPUT at one realistic fill, grades hard tasks by
// execution, and computes the real cost from the API usage object. Answers
// "what is the best (quality per dollar) setup?" instead of just "does it
// work?".

/** USD per 1M tokens — DeepSeek platform prices (configurable via CLI). */
const DEFAULT_PRICES = { inMiss: 0.28, inHit: 0.028, out: 0.42 };

function estimateCost(usage, prices) {
    if (!usage) return 0;
    const inTok = usage.input_tokens || 0;
    const cached = usage.input_tokens_details?.cached_tokens || 0;
    const outTok = usage.output_tokens || 0;
    return ((inTok - cached) * prices.inMiss + cached * prices.inHit + outTok * prices.out) / 1e6;
}

/** Average reasoning tokens burned per answer in a probe (drives cost + latency). */
function meanReasoningTokens(probe) {
    let sum = 0, n = 0;
    for (const r of probe.results) {
        const rt = r.usage?.output_tokens_details?.reasoning_tokens;
        if (typeof rt === 'number') { sum += rt; n++; }
    }
    return n ? Math.round(sum / n) : 0;
}

/**
 * Setup scan (--setup-scan): run the hard tasks across a matrix of
 * {thinking} × {maxOutput} at a fixed fill (default 55% ≈ 500K on a 950K
 * window — the region where the user reports good results), and report
 * quality, overthinking, reasoning burn, and DOLLAR cost per probe. Picks the
 * best value cell (meets threshold at lowest cost) and the best quality cell.
 *
 * Usage:
 *   --setup-scan [--setup-fill=55] [--thinking-sweep=off,low,high]
 *                [--max-output-sweep=4096,16384,32768]
 *                [--price-in-miss=.. --price-in-hit=.. --price-out=..]
 */
async function scanSetup(opts, anchorMsgs, availableInputTokens) {
    const thinkings = opts.thinkingSweep;
    const maxOutputs = opts.maxOutputSweep;
    const fillPct = opts.setupFill;
    const prices = { inMiss: opts.priceInMiss, inHit: opts.priceInHit, out: opts.priceOut };
    const estInput = Math.round((availableInputTokens * fillPct) / 100);
    const cells = thinkings.length * maxOutputs.length;

    console.log(`Setup scan: ${thinkings.length} thinking × ${maxOutputs.length} output budgets = ${cells} cells, ${opts.tasksPerProbe} hard task(s) each, at ${fillPct}% fill (~${estInput.toLocaleString()} tok input per call).`);
    console.log(`Prices (USD/1M): in-miss $${prices.inMiss}, in-hit $${prices.inHit}, out $${prices.out}  (override with --price-*)`);
    const estCell = ((estInput) * prices.inMiss + 3000 * prices.out) / 1e6;
    console.log(`Rough worst-case: ~$${(estCell * opts.tasksPerProbe).toFixed(3)}/cell (all cache-MISS). Prompt caching cuts input cost ~10× after the first call.`);
    console.log('');

    if (opts.dry) {
        for (const th of thinkings) for (const mo of maxOutputs) {
            console.log(`  thinking=${String(th).padEnd(4)} max_output ${String(mo).padStart(6)}  (dry — would grade ${opts.tasksPerProbe} task(s))`);
        }
        console.log('');
        console.log('(dry) run without --dry to measure real quality + cost.');
        return;
    }

    const rows = [];
    for (const th of thinkings) {
        for (const mo of maxOutputs) {
            const probe = await probeHardCode(opts, anchorMsgs, availableInputTokens, fillPct, mo, th);
            const errs = probe.results.filter(r => r.err);
            const cost = probe.results.reduce((s, r) => s + estimateCost(r.usage, prices), 0);
            const reason = meanReasoningTokens(probe);
            const truncated = probe.results.filter(r => r.reasoning && r.reasoning.truncated).length;
            const prods = probe.results.map(r => { const p = r.product || {}; return `${r.task}${p.hasConsoleLog ? '!log' : ''}${p.hasImport ? '!imp' : ''}${p.hasDateNow ? '!now' : ''}`; });
            const detail = probe.results.map(r => `${r.task}:${r.passed}/${r.total}${r.reasoning && r.reasoning.spinScore >= 40 ? '*' : ''}`).join(' ');

            if (errs.length === probe.results.length) {
                console.log(`  ✗ thinking=${String(th).padEnd(4)} max_output ${String(mo).padStart(6)}  API error(s): ${errs.map(r => r.err).join(' | ')}`);
                continue;
            }
            rows.push({ th, mo, pass: probe.meanCompliance, spin: probe.meanSpin, cost, reason, truncated, detail });
            console.log(`  thinking=${String(th).padEnd(4)} max_output ${String(mo).padStart(6)}  pass ${String(probe.meanCompliance).padStart(3)}%  spin ${String(probe.meanSpin).padStart(3)}%  reason ${String(reason).padStart(5)} tok  trunc ${truncated}/${probe.results.length}  $${cost.toFixed(3)}  ${detail}`);
            console.log(`       product: ${prods.join(' | ')}`);
        }
    }

    console.log('');
    console.log(BAR);
    if (rows.length === 0) {
        console.log('No usable cells (all API errors).');
        return;
    }

    // Best value: among cells that meet the threshold, find the cheapest, then
    // within a small cost band of it prefer the HIGHEST quality — a cent of
    // savings is not worth 20 points of reliability (observed: thinking=off
    // saved $0.001 but dropped 100% → 77%). Among EXACTLY tied quality+cost,
    // prefer the LOWEST thinking effort (faster, less reasoning burn) — the
    // user runs off/none + low, not max; a max cell winning on a ~$0.0001
    // float diff is a tiebreak artifact, not a real win.
    const THINKING_RANK = { off: 0, low: 1, high: 2, max: 3 };
    const good = rows.filter(r => r.pass >= opts.threshold);
    let bestValue = null, bestQuality = null;
    if (good.length) {
        const minCost = Math.min(...good.map(r => r.cost));
        const band = good.filter(r => r.cost <= minCost * 1.1);
        band.sort((a, b) =>
            b.pass - a.pass ||
            a.cost - b.cost ||
            (THINKING_RANK[a.th] ?? 9) - (THINKING_RANK[b.th] ?? 9)
        );
        bestValue = band[0];
    }
    rows.slice().sort((a, b) => b.pass - a.pass || a.cost - b.cost);
    bestQuality = rows[0];

    console.log('SETUP RECOMMENDATION');
    if (bestValue) {
        console.log(`  BEST VALUE (≥${opts.threshold}% at lowest cost): thinking=${bestValue.th}  maxOutput=${bestValue.mo.toLocaleString()}  → ${bestValue.pass}% pass, $${bestValue.cost.toFixed(3)}/probe`);
    } else {
        console.log(`  ⚠ No config reached ${opts.threshold}% at this fill — raise --setup-fill lower / check tasks.`);
    }
    if (bestQuality && (!bestValue || bestQuality.pass > bestValue.pass)) {
        const delta = bestQuality.cost - bestValue.cost;
        console.log(`  BEST QUALITY: thinking=${bestQuality.th}  maxOutput=${bestQuality.mo.toLocaleString()}  → ${bestQuality.pass}% pass, $${bestQuality.cost.toFixed(3)}/probe  (+$${delta.toFixed(3)} vs best value)`);
    }
    // Per-thinking-level verdict — answers "I use off/low: what do I get?".
    console.log('  Per thinking level (your operating points):');
    for (const th of thinkings) {
        const cells = rows.filter(r => r.th === th && r.pass >= opts.threshold);
        if (!cells.length) {
            console.log(`    thinking=${String(th).padEnd(4)} → no cell reached ${opts.threshold}% at this fill`);
            continue;
        }
        const best = cells.slice().sort((a, b) => b.pass - a.pass || a.cost - b.cost)[0];
        const ok = best.pass >= opts.threshold ? 'OK' : '⚠ degrading';
        console.log(`    thinking=${String(th).padEnd(4)} → best ${best.pass}% pass @ maxOutput ${best.mo.toLocaleString()} (${ok}, $${best.cost.toFixed(3)}/probe, spin ${best.spin}%)`);
    }
    console.log('');
    console.log('Full ranking (best quality → worst):');
    console.log(`${'thinking'.padEnd(9)}${'maxOutput'.padEnd(11)}${'pass%'.padEnd(7)}${'spin%'.padEnd(7)}${'reason tok'.padEnd(11)}${'trunc'.padEnd(7)}${'cost/probe'}`);
    rows.slice().sort((a, b) => b.pass - a.pass || a.cost - b.cost).forEach(r => {
        console.log(`${String(r.th).padEnd(9)}${String(r.mo.toLocaleString()).padEnd(11)}${String(r.pass).padEnd(7)}${String(r.spin).padEnd(7)}${String(r.reason).padEnd(11)}${String(r.truncated).padEnd(7)}$${r.cost.toFixed(4)}`);
    });
    console.log('');
    console.log('How to read it:');
    console.log('  - pass% = real executed test-pass rate at this thinking × output budget.');
    console.log('  - reason tok = reasoning tokens burned per answer (costs like OUTPUT tokens — this is what thinking=high/max inflates).');
    console.log('  - cost/probe = real dollars from the API usage object (input miss/hit + output).');
    console.log('  - Window cost scales LINEARLY with context size — at 500K a 2× window ≈ 2× input cost per call.');
}

/**
 * Scan fill levels for the code-quality break point, then refine with one
 * bisection probe. Prints the NEW LIMIT for this model. Works for both the
 * contract-compliance (code) and executable (hard) scenarios.
 */
async function findLimit(opts, anchorMsgs, availableInputTokens, isHard) {
    const probe = (fillPct) => isHard
        ? probeHardCode(opts, anchorMsgs, availableInputTokens, fillPct)
        : probeCodeQuality(opts, anchorMsgs, availableInputTokens, fillPct);
    const coarse = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
    console.log(`Scanning ${coarse.length} fill levels of a ${opts.window.toLocaleString()} token window for the code-quality break point...`);
    console.log(`  Break = compliance below ${opts.threshold}%. Each level: ${opts.tasksPerProbe} task(s).${opts.dry ? '  [DRY — truncation levels only]' : ''}`);
    if (opts.compactLimit > 0) console.log(`  Compaction ON at ${opts.compactLimit.toLocaleString()} tokens (measures the IDEAL-summary upper bound).`);
    console.log('');

    if (opts.dry) {
        for (const fillPct of coarse) {
            const { messages: raw } = buildConversation(fillPct, anchorMsgs, opts.window, opts.maxOutput);
            const rawTokens = estimateMessageTokens(raw);
            const truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
            const survived = survivingAnchorIndexes(truncated, 'CONTRACT');
            const tok = Math.round((availableInputTokens * fillPct) / 100);
            const anchorCount = anchorMsgs.filter(m => m.role === 'user' && /^CONTRACT_\d+:/.test(m.content)).length;
            let extra = `contracts kept: ${survived.size}/${anchorCount}`;
            if (opts.compactLimit > 0) {
                const c = compactConversation(truncated, opts.compactLimit, anchorMsgs, opts.compactStyle);
                extra += c.compacted ? ` | compacted → ~${estimateMessageTokens(c.messages).toLocaleString()} tok` : ' | compaction not triggered';
            }
            console.log(`  fill ${String(fillPct).padStart(3)}% → ~${tok.toLocaleString()} tok  (${extra})`);
        }
        console.log('');
        console.log('(dry) run without --dry to measure actual code compliance at these levels.');
        return;
    }

    let lastGood = null;       // last fill% at/above threshold
    let firstBad = null;       // first fill% that truly degraded (real answers, low compliance)
    let ceilingFill = null;    // first fill% where the API rejected (context overflow)
    let lastGoodReal = 0;      // real input tokens at lastGood
    let lastGoodTok = 0;
    for (const fillPct of coarse) {
        const probeRes = await probe(fillPct);
        const tok = Math.round((availableInputTokens * fillPct) / 100);
        const errs = probeRes.results.filter(r => r.err);
        const allErrored = errs.length === probeRes.results.length;
        const real = probeRes.realInputTokens ? `  (real input: ${probeRes.realInputTokens.toLocaleString()} tok)` : '';
        const comp = probeRes.compacted ? '  [compacted]' : '';

        if (allErrored) {
            // Context overflow — real tokens exceeded the model's hard limit.
            console.log(`  ⚠ CEILING fill ${String(fillPct).padStart(3)}% (~${tok.toLocaleString()} tok) — API rejected: real tokens exceeded the 1,048,576 context limit. Stopping (higher fills only get worse).`);
            ceilingFill = fillPct;
            break;
        }

        const flag = probeRes.meanCompliance >= opts.threshold ? 'OK ' : 'BAD';
        console.log(`  ${flag} fill ${String(fillPct).padStart(3)}% (~${tok.toLocaleString()} tok)  compliance ${probeRes.meanCompliance}%${real}${comp}`);
        if (errs.length) console.log(`       ⚠ partial API error(s): ${errs.map(r => r.err).join(' | ')}`);
        if (isHard) {
            const summary = probeRes.results.map(r => `${r.task}:${r.passed}/${r.total}`).join(' ');
            console.log(`       tests: ${summary}`);
        }
        if (probeRes.meanCompliance >= opts.threshold) {
            lastGood = fillPct;
            lastGoodReal = probeRes.realInputTokens;
            lastGoodTok = tok;
        } else if (firstBad === null) {
            firstBad = fillPct;
        }
    }

    console.log('');
    console.log(BAR);
    if (lastGood === null) {
        console.log(`Even the smallest level degraded (< ${opts.threshold}%). The tasks may be too hard — try --threshold lower or --tasks higher.`);
        return;
    }
    if (firstBad === null) {
        // No real quality degradation at any level we could measure.
        if (ceilingFill !== null) {
            console.log(`No code-quality degradation observed up to the API's context ceiling.`);
            console.log(`NEW LIMIT (${opts.model}): the FULL usable window — code quality held through ~${lastGoodReal.toLocaleString()} real tokens (${lastGood}% estimated fill).`);
            console.log(`Hard ceiling: the model's 1,048,576-token context. Beyond it the API returns HTTP 400 — that is a context ceiling, not a quality drop.`);
        } else {
            const tok = Math.round((availableInputTokens * 99) / 100);
            console.log(`No break point up to ~${tok.toLocaleString()} tokens — compliance stayed ≥ ${opts.threshold}% everywhere.`);
            console.log(`NEW LIMIT: at least ~${tok.toLocaleString()} tokens (the full window held up).`);
        }
        return;
    }

    // Real degradation found → refine with one bisection probe.
    const mid = Math.round((lastGood + firstBad) / 2);
    const probeRes = await probe(mid);
    const tokMid = Math.round((availableInputTokens * mid) / 100);
    const errs = probeRes.results.filter(r => r.err);
    let flag;
    if (errs.length === probeRes.results.length) {
        flag = 'CEILING';
    } else {
        flag = probeRes.meanCompliance >= opts.threshold ? 'OK' : 'BAD';
    }
    const real = probeRes.realInputTokens ? `  (real input: ${probeRes.realInputTokens.toLocaleString()} tok)` : '';
    console.log(`  refinement at fill ${mid}% (~${tokMid.toLocaleString()} tok): compliance ${probeRes.meanCompliance}% → ${flag}${real}`);
    if (errs.length) console.log(`       ⚠ API error(s): ${errs.map(r => r.err).join(' | ')}`);
    const refinedGood = flag === 'OK' ? mid : lastGood;
    const refinedBad = flag === 'OK' ? firstBad : mid;

    const limitTok = Math.round((availableInputTokens * refinedGood) / 100);
    const badTok = Math.round((availableInputTokens * refinedBad) / 100);
    console.log('');
    console.log(BAR);
    console.log(`NEW LIMIT (${opts.model}):`);
    console.log(`  code quality holds up to ~${limitTok.toLocaleString()} tokens (${refinedGood}% fill)`);
    console.log(`  degrades by ~${badTok.toLocaleString()} tokens (${refinedBad}% fill)`);
    if (opts.compactLimit > 0) {
        console.log(`  (compaction was ON at ${opts.compactLimit.toLocaleString()} tokens with an IDEAL summary — this is an upper bound on what compaction can buy.)`);
    }
    if (ceilingFill !== null) {
        console.log(`  (note: the level at ${ceilingFill}%+ was the API's context ceiling (HTTP 400), not a quality drop.)`);
    }
    console.log('');
    console.log('Practical advice: keep agentic sessions under the limit; past it, prefer');
    console.log('fresh sessions, grep/ripgrep lookups, and compaction over full-context recall.');
}

/**
 * Per-level scan (no auto-limit detection) with scenario-aware summaries.
 */
async function runScan(opts, anchors, anchorMsgs, availableInputTokens, isCode, isHard, prefix) {
    const report = [];

    for (const fillPct of opts.fills) {
        const { messages: raw } = buildConversation(fillPct, anchorMsgs, opts.window, opts.maxOutput);
        const rawTokens = estimateMessageTokens(raw);
        let truncated = truncateMessagesToContextWindow(raw, opts.window, opts.maxOutput);
        let compacted = false;
        if (isHard && opts.compactLimit > 0) {
            const c = compactConversation(truncated, opts.compactLimit, anchorMsgs, opts.compactStyle);
            truncated = c.messages;
            compacted = c.compacted;
        }
        const sentTokens = estimateMessageTokens(truncated);
        const actualFill = Math.round((rawTokens / availableInputTokens) * 100);
        const survived = survivingAnchorIndexes(truncated, prefix);
        const droppedIdx = anchors.map((_, i) => i).filter(i => !survived.has(i));
        const inWindowIdx = anchors.map((_, i) => i).filter(i => survived.has(i));

        const row = { fillPct: actualFill, sentTokens, inWindow: inWindowIdx, dropped: droppedIdx, results: {} };

        console.log(BAR);
        console.log(`Fill: ${actualFill}%  |  raw ~${rawTokens.toLocaleString()} tok  →  sent ~${sentTokens.toLocaleString()} tok  |  ${prefix}s in window: ${inWindowIdx.length}/${anchors.length}${droppedIdx.length ? `  ⚠ dropped: ${droppedIdx.length}` : ''}${compacted ? '  [compacted]' : ''}`);

        if (opts.dry) {
            if (droppedIdx.length) console.log(`  (dry) would drop ${prefix.toLowerCase()}s #${droppedIdx.join(', ')}`);
            report.push(row);
            continue;
        }

        if (isHard) {
            const probe = await probeHardCode(opts, anchorMsgs, availableInputTokens, fillPct);
            row.results.hard = probe;
            const perTask = probe.results.map(r => `${r.task}:${r.passed}/${r.total}${r.reasoning && r.reasoning.spinScore >= 40 ? '*' : ''}`).join('  ');
            console.log(`  test pass rate: ${probe.meanCompliance}% across ${opts.tasksPerProbe} task(s)  (overthink/spin: ${probe.meanSpin}%, * = high)`);
            console.log(`    ${perTask}`);
            const bad = probe.results.filter(r => r.compliance < 100);
            if (bad.length) console.log(`  ⚠ ${bad.map(r => `${r.task} (${r.compliance}%)${r.error ? ' — ' + r.error.slice(0, 120) : ''}`).join(' | ')}`);
            const spun = probe.results.filter(r => r.reasoning && r.reasoning.spinScore >= 40);
            if (spun.length) console.log(`  ⚠ overthinking: ${spun.map(r => `${r.task} (rep ${r.reasoning.repetition}%${r.reasoning.truncated ? ', truncated' : ''})`).join(' | ')}`);
        } else if (isCode) {
            const probe = await probeCodeQuality(opts, anchorMsgs, availableInputTokens, fillPct);
            row.results.code = probe;
            const issues = new Set();
            probe.results.forEach((r, t) => {
                r.grades.forEach(g => {
                    if (!g.satisfied && g.violated) issues.add(`${g.name} (task ${t + 1}: used forbidden pattern)`);
                    else if (!g.satisfied) issues.add(`${g.name} (task ${t + 1}: omitted)`);
                });
            });
            console.log(`  compliance: ${probe.meanCompliance}% across ${opts.tasksPerProbe} task(s)`);
            if (issues.size) console.log(`  ⚠ ${[...issues].join(' | ')}`);
        } else {
            // Recall path: query each fact (in-window AND dropped).
            const prompt = [...truncated];
            if (prompt.length && prompt[prompt.length - 1].role === 'tool') {
                prompt.push({ role: 'assistant', content: 'Understood. I will continue with the next request.' });
            }
            for (const idx of [...inWindowIdx, ...droppedIdx]) {
                const f = anchors[idx];
                const question = { role: 'user', content: `${f.q}\n(Answer from the conversation above only. If it is not there, say you do not have that information.)` };
                let grade, answer;
                try {
                    const res = await ask([...prompt, question], opts.key, opts.model, 256, opts.api, opts.thinking);
                    answer = (res.text || '').trim();
                    grade = gradeAnswer(answer, f);
                } catch (err) {
                    console.error(`  ✗ fact #${idx} API error: ${err.message}`);
                    answer = '';
                    grade = 'ERROR';
                }
                row.results[idx] = { grade, answer };
                const mark = grade === 'CORRECT' ? '✓' : grade === 'UNSURE' ? '·' : grade === 'HALLUCINATED' ? '✗ FABRICATED' : '!';
                const where = droppedIdx.includes(idx) ? 'dropped' : 'in-window';
                console.log(`  [${where}] #${idx} ${mark} ${f.q} → ${answer.slice(0, 90)}${answer.length > 90 ? '…' : ''}`);
            }
        }
        report.push(row);
    }

    // ── Summary ──
    console.log('');
    console.log(BAR);
    if (isHard) {
        if (opts.scenario === 'multiturn') {
            console.log('SUMMARY — multi-turn consistency vs context fill (prior endpoints + contract must survive a long session, graded by execution)');
        } else {
            console.log('SUMMARY — hard-code quality vs context fill (real algorithms, graded by execution)');
        }
        console.log(`${'fill%'.padEnd(8)}${'~tokens'.padEnd(14)}${'pass%'.padEnd(10)}status`);
        for (const row of report) {
            const c = row.results.hard?.meanCompliance;
            const status = c === undefined ? '—' : (c >= opts.threshold ? 'OK' : '⚠ degrading');
            console.log(`${String(row.fillPct).padEnd(8)}${row.sentTokens.toLocaleString().padEnd(14)}${String(c ?? '-').padEnd(10)}${status}`);
        }
        const deg = report.filter(r => r.results.hard && r.results.hard.meanCompliance < opts.threshold);
        if (opts.dry) {
            console.log('');
            console.log('(dry run — no measurements taken. Run without --dry to measure actual test-pass rates.)');
        } else if (deg.length) {
            const first = deg[0];
            console.log('');
            console.log(`BREAK POINT: first degradation at ~${first.sentTokens.toLocaleString()} tokens (${first.fillPct}% fill, ${first.results.hard.meanCompliance}% test pass).`);
            console.log('Run with --find-limit for a refined estimate.');
        } else {
            console.log('');
            console.log(`No degradation observed up to the highest fill tested (test pass ≥ ${opts.threshold}% everywhere). Try --find-limit.`);
        }
    } else if (isCode) {
        console.log('SUMMARY — code quality vs context fill (conventions embedded at conversation START)');
        console.log(`${'fill%'.padEnd(8)}${'~tokens'.padEnd(14)}${'compliance'.padEnd(12)}status`);
        for (const row of report) {
            const c = row.results.code?.meanCompliance;
            const status = c === undefined ? '—' : (c >= opts.threshold ? 'OK' : '⚠ degrading');
            console.log(`${String(row.fillPct).padEnd(8)}${row.sentTokens.toLocaleString().padEnd(14)}${String(c ?? '-').padEnd(12)}${status}`);
        }
        const deg = report.filter(r => r.results.code && r.results.code.meanCompliance < opts.threshold);
        if (deg.length) {
            const first = deg[0];
            console.log('');
            console.log(`BREAK POINT: first degradation at ~${first.sentTokens.toLocaleString()} tokens (${first.fillPct}% fill, compliance ${first.results.code.meanCompliance}%).`);
            console.log('Run with --find-limit for a refined estimate.');
        } else {
            console.log('');
            console.log(`No degradation observed up to the highest fill tested (compliance ≥ ${opts.threshold}% everywhere). Try --find-limit.`);
        }
    } else {
        console.log('SUMMARY A — long-context health (facts still IN the window; degraded recall here = "lost in the middle")');
        console.log(`${'fill%'.padEnd(8)}${'correct'.padEnd(9)}${'unsure'.padEnd(9)}${'fabricated'.padEnd(12)}recall accuracy`);
        for (const row of report) {
            const res = row.inWindow.map(i => row.results[i]?.grade);
            if (res.length === 0) {
                console.log(`${String(row.fillPct).padEnd(8)}${'-'.padEnd(9)}${'-'.padEnd(9)}${'-'.padEnd(12)}—`);
                continue;
            }
            const c = res.filter(g => g === 'CORRECT').length;
            const u = res.filter(g => g === 'UNSURE').length;
            const h = res.filter(g => g === 'HALLUCINATED').length;
            console.log(`${String(row.fillPct).padEnd(8)}${String(c).padEnd(9)}${String(u).padEnd(9)}${String(h).padEnd(12)}${Math.round((c / res.length) * 100)}%`);
        }
        console.log('');
        console.log(BAR);
        console.log('SUMMARY B — hallucination on forgotten facts (dropped by truncation; model could NOT see them)');
        console.log(`${'fill%'.padEnd(8)}${'facts dropped'.padEnd(14)}${'correct'.padEnd(9)}${'unsure'.padEnd(9)}${'fabricated'.padEnd(12)}hallucination rate`);
        for (const row of report) {
            const dropped = row.dropped;
            const res = dropped.map(i => row.results[i]?.grade);
            if (res.length === 0) {
                console.log(`${String(row.fillPct).padEnd(8)}${String(0).padEnd(14)}${'-'.padEnd(9)}${'-'.padEnd(9)}${'-'.padEnd(12)}—`);
                continue;
            }
            const c = res.filter(g => g === 'CORRECT').length;
            const u = res.filter(g => g === 'UNSURE').length;
            const h = res.filter(g => g === 'HALLUCINATED').length;
            const rate = res.length ? Math.round((h / res.length) * 100) : 0;
            console.log(`${String(row.fillPct).padEnd(8)}${String(dropped.length).padEnd(14)}${String(c).padEnd(9)}${String(u).padEnd(9)}${String(h).padEnd(12)}${rate}%`);
        }
        console.log('');
        console.log('Interpretation:');
        console.log('  - SUMMARY A: with all facts still in the prompt, does recall degrade as the window fills');
        console.log('    (long-context attention loss, a.k.a. "lost in the middle")? Expect ~100% here.');
        console.log('  - SUMMARY B: facts the truncation dropped. "fabricated" = confident WRONG answer');
        console.log('    (hallucination); "unsure" = honest "I don\'t know". This is your real hallucination risk.');
        console.log('  - First fill% with "facts dropped" in SUMMARY B = your effective memory limit.');
        const totalSent = report.reduce((s, r) => s + r.sentTokens * (r.inWindow.length + r.dropped.length || 0), 0);
        console.log(`  - Total tokens sent across this run: ~${totalSent.toLocaleString()} (DeepSeek prompt caching makes repeat questions cheap).`);
    }

    if (opts.json) {
        console.log('\nJSON_REPORT_BEGIN');
        console.log(JSON.stringify(report.map(r => {
            const base = { fillPct: r.fillPct, sentTokens: r.sentTokens, contractsDropped: r.dropped.length };
            if (r.results.hard) {
                return { ...base, hard: r.results.hard.results.map(x => ({ task: x.task, passed: x.passed, total: x.total, compliance: x.compliance })), meanCompliance: r.results.hard.meanCompliance };
            }
            if (r.results.code) {
                return { ...base, compliance: r.results.code.meanCompliance };
            }
            return { ...base, grades: Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, v.grade])) };
        }), null, 2));
        console.log('JSON_REPORT_END');
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
