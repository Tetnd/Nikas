// test-memory.js — unit tests for persistent session memory (src/memory/store.ts),
// v0.7.80. The store is vscode-free by design, so we test the compiled output
// directly with plain node.
//
// Covers: upsert/get/getEntry/remove, LRU cap, hydrate/snapshot round-trip,
// renderMarkdown/parseMarkdown round-trip, deriveMemoryKey, the never-throws
// safety guarantee, and reset.

const { MemoryStore, deriveMemoryKey } = require('./out/memory/store.js');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
    if (cond) { passed++; }
    else { failed++; failures.push(name); console.error('  FAIL: ' + name); }
}

// ── 1. deriveMemoryKey ──
assert(deriveMemoryKey('ws1', 'sessA') === 'ws1|sessA', 'deriveMemoryKey combines');
assert(deriveMemoryKey('ws1', 'sessA') !== deriveMemoryKey('ws2', 'sessA'), 'different workspace → different key');
assert(deriveMemoryKey('ws1', 'sessA') !== deriveMemoryKey('ws1', 'sessB'), 'different session → different key');

// ── 2. upsert / get / getEntry / remove ──
{
    const s = new MemoryStore();
    s.upsert('ws1', 'sessA', 'fix pdf crash', 'compaction');
    assert(s.get('ws1', 'sessA') === 'fix pdf crash', 'get returns summary');
    assert(s.get('ws1', 'sessB') === undefined, 'get miss → undefined');
    assert(s.get('ws2', 'sessA') === undefined, 'workspace isolation');
    const e = s.getEntry('ws1', 'sessA');
    assert(e && e.summary === 'fix pdf crash', 'getEntry returns entry');
    assert(e && e.source === 'compaction', 'getEntry source');
    assert(e && typeof e.updatedAt === 'number', 'getEntry updatedAt number');
    assert(s.size === 1, 'size = 1');
    s.remove('ws1', 'sessA');
    assert(s.get('ws1', 'sessA') === undefined, 'remove clears');
    assert(s.size === 0, 'size 0 after remove');
}

// ── 3. upsert overwrites ──
{
    const s = new MemoryStore();
    s.upsert('ws1', 'sessA', 'v1');
    s.upsert('ws1', 'sessA', 'v2');
    assert(s.get('ws1', 'sessA') === 'v2', 'upsert overwrites');
    assert(s.size === 1, 'upsert does not duplicate');
}

// ── 4. LRU cap (MAX_ENTRIES = 100) ──
{
    const s = new MemoryStore();
    for (let i = 0; i < 105; i++) {
        s.upsert('ws1', 'sess' + i, 'summary ' + i);
    }
    assert(s.size === 100, 'capped at 100 (' + s.size + ')');
    assert(s.get('ws1', 'sess0') === undefined, 'oldest evicted');
    assert(s.get('ws1', 'sess4') === undefined, 'oldest batch evicted');
    assert(s.get('ws1', 'sess104') !== undefined, 'newest kept');
}

// ── 5. hydrate / snapshot round-trip ──
{
    const s = new MemoryStore();
    s.upsert('ws1', 'sessA', 'alpha', 'compaction');
    s.upsert('ws2', 'sessB', 'beta', 'compact-command');
    const snap = s.snapshot();
    assert(snap.entries.length === 2, 'snapshot has 2 entries');
    const s2 = new MemoryStore();
    s2.hydrate(snap);
    assert(s2.get('ws1', 'sessA') === 'alpha', 'hydrate restores A');
    assert(s2.get('ws2', 'sessB') === 'beta', 'hydrate restores B');
    assert(s2.getEntry('ws2', 'sessB').source === 'compact-command', 'hydrate restores source');
    assert(s2.size === 2, 'hydrate size');
}

// ── 6. renderMarkdown / parseMarkdown round-trip ──
{
    const s = new MemoryStore();
    s.upsert('ws1', 'sessA', 'fix pdf crash\n- path: src/pdf/manager.ts\n- keep P10 alias-guard', 'compaction');
    s.upsert('ws1', 'sessB', 'add usage tracker', 'compaction');
    const md = s.renderMarkdown();
    assert(md.startsWith('# Nikas Session Memory'), 'markdown header present');
    assert(md.includes('## Session ws1|sessA'), 'markdown section A');
    assert(md.includes('## Session ws1|sessB'), 'markdown section B');
    assert(md.includes('fix pdf crash'), 'markdown body A');

    const parsed = MemoryStore.parseMarkdown(md);
    assert(parsed.length === 2, 'parseMarkdown finds 2 entries');
    const a = parsed.find(e => e.key === 'ws1|sessA');
    assert(a && a.summary.includes('fix pdf crash'), 'parsed A summary');
    assert(a && a.summary.includes('- path: src/pdf/manager.ts'), 'parsed A preserves newlines');
    const b = parsed.find(e => e.key === 'ws1|sessB');
    assert(b && b.summary === 'add usage tracker', 'parsed B summary');
    assert(a && typeof a.updatedAt === 'number' && a.updatedAt > 0, 'parsed A updatedAt');
    assert(a && a.source === 'compaction', 'parsed A source');
}

// ── 7. parseMarkdown garbage-safe ──
{
    assert(MemoryStore.parseMarkdown('') .length === 0, 'empty → []');
    assert(MemoryStore.parseMarkdown('no headers here') .length === 0, 'no headers → []');
    assert(MemoryStore.parseMarkdown('## Session \n\n') .length === 0, 'empty key → []');
    assert(MemoryStore.parseMarkdown('## Session k\n\n') .length === 0, 'no body → []');
    const bad = MemoryStore.parseMarkdown('\n## Session k\n- updated: not-a-date\n\nbody');
    assert(bad.length === 1 && bad[0].summary === 'body', 'bad date → default updatedAt, body kept');
}

// ── 8. never-throws safety ──
{
    const s = new MemoryStore();
    let threw = false;
    try {
        s.upsert(undefined, 's', 'x');
        s.upsert('w', undefined, 'x');
        s.upsert('w', 's', undefined);
        s.upsert('w', 's', { not: 'a string' });
        s.get(undefined, undefined);
        s.getEntry(null, null);
        s.remove(undefined, undefined);
        s.hydrate({ entries: 'garbage' });
        s.hydrate(undefined);
        s.hydrate({ entries: [{ key: 5, summary: undefined }] });
        s.snapshot();
        s.renderMarkdown();
        s.reset();
    } catch (e) {
        threw = true;
        console.error('  threw: ' + e);
    }
    assert(!threw, 'never throws on bad input');
}

// ── 9. reset ──
{
    const s = new MemoryStore();
    let fired = 0;
    s.onDidChange(() => fired++);
    s.upsert('ws1', 'sessA', 'x');
    s.reset();
    assert(s.size === 0, 'reset clears');
    assert(s.get('ws1', 'sessA') === undefined, 'reset removes entries');
    assert(fired >= 2, 'onDidChange fired on upsert + reset');
}

// ── 10. persistence callback fired ──
{
    const s = new MemoryStore();
    let saved;
    s.setPersistence((snap) => { saved = snap; });
    s.upsert('ws1', 'sessA', 'x');
    assert(saved && saved.entries.length === 1, 'persistence callback fired');
    assert(saved.entries[0].key === 'ws1|sessA', 'persisted entry key');
}

console.log('');
console.log(`test-memory: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('Failures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
