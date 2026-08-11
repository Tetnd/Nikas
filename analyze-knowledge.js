#!/usr/bin/env node
/**
 * analyze-knowledge.js — measure whether the Copilot-knowledge enrichment is
 * actually steering DeepSeek's tool choices, from a REAL live session log.
 *
 * Pure observability: reads nikas.log, no network, no side effects. Reports:
 *   1. Enrichment coverage — how many distinct tools were enriched vs passed through.
 *   2. Tool-choice stats — which native tools DeepSeek actually requested, in what
 *      proportions, grouped by category.
 *   3. Whether DeepSeek is using Copilot-native tools (browser, edit, terminal)
 *      appropriately vs. falling back to the catalog-less paths.
 *
 * Run: node analyze-knowledge.js [path-to-nikas.log]
 */
const fs = require('fs');
const path = require('path');

const logFile = process.argv[2] || path.join(process.cwd(), 'nikas.log');
if (!fs.existsSync(logFile)) {
    console.error(`No log file at ${logFile}`);
    process.exit(1);
}

// Minimal category map mirroring the catalog categories (for grouping).
const CATEGORY_HINTS = [
    ['file', /read|view_image|list_dir|list_directory/],
    ['edit', /edit|write_file|create_file|create_directory|rename|apply_patch|insert_edit|replace_string|multi_replace/],
    ['search', /search|grep|find|codebase|usages|semantic/],
    ['terminal', /terminal|run_in|runIn|run_command|execute|send_to|kill|get_task_output|run_tests|run_task|create_and_run|testFailure|test_failure/],
    ['browser', /browser|page|click|type|hover|drag|screenshot|playwright|handle_dialog/],
    ['notebook', /notebook/],
    ['task', /todo|task|plan|agent|runSubagent|subagent|tool_search/],
    ['vscode', /vscode|askQuestions|install_extension|renameSymbol|listCodeUsages/],
    ['web', /web|fetch|github|repo|http/],
    ['container', /container/],
];

function categorize(name) {
    const n = name.toLowerCase();
    for (const [cat, re] of CATEGORY_HINTS) {
        if (re.test(n)) return cat;
    }
    return 'other';
}

const lines = fs.readFileSync(logFile, 'utf8').split('\n');

// Collect enriched-tool INFO lines and tool-request INFO lines.
const enrichedTools = new Set();      // tool names the catalog enriched
const passedThrough = new Set();      // tool names passed through unchanged (verbose lines)
const requests = new Map();           // tool name -> count (from [tool-req])
const requestOrder = [];              // preserve first-seen order

for (const line of lines) {
    // e.g. [knowledge] tool 'read' enriched (category: file)
    let m = line.match(/\[knowledge\] tool '([^']+)' enriched \(category: ([^)]+)\)/);
    if (m) { enrichedTools.add(m[1]); continue; }
    // e.g. [knowledge] tool 'x' not in catalog — passed through unchanged
    m = line.match(/\[knowledge\] tool '([^']+)' not in catalog/);
    if (m) { passedThrough.add(m[1]); continue; }
    // e.g. [tool-req] DeepSeek requested: read, editFiles, runInTerminal
    m = line.match(/\[tool-req\] DeepSeek requested: (.*)/);
    if (m) {
        for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
            if (!requests.has(name)) requestOrder.push(name);
            requests.set(name, (requests.get(name) || 0) + 1);
        }
    }
}

const fmt = n => n.toLocaleString();
console.log('=== Copilot-Knowledge Enrichment Analysis (live log) ===\n');

const knownTotal = enrichedTools.size + passedThrough.size;
console.log('Enrichment coverage:');
console.log(`  tools the catalog enriched : ${fmt(enrichedTools.size)}`);
console.log(`  tools passed through       : ${fmt(passedThrough.size)}`);
console.log(`  catalog coverage           : ${knownTotal ? (enrichedTools.size / knownTotal * 100).toFixed(1) + '%' : 'n/a'}\n`);

console.log(`DeepSeek tool requests observed: ${fmt([...requests.values()].reduce((a, b) => a + b, 0))} total, ${fmt(requests.size)} distinct tools\n`);

if (requests.size === 0) {
    console.log('No [tool-req] lines found yet. Use the extension with knowledge ON (nikas.copilotKnowledge=true),\nthen re-run this script.');
    process.exit(0);
}

console.log('Top requested tools (by count):');
const byCount = requestOrder
    .map(n => ({ name: n, count: requests.get(n) }))
    .sort((a, b) => b.count - a.count);
for (const { name, count } of byCount.slice(0, 20)) {
    console.log(`  ${fmt(count).padStart(5)}  ${name}`);
}

console.log('\nTool choice by category (requested):');
const catCount = new Map();
for (const name of requestOrder) {
    const cat = categorize(name);
    catCount.set(cat, (catCount.get(cat) || 0) + requests.get(name));
}
const totalReqs = [...catCount.values()].reduce((a, b) => a + b, 0);
for (const [cat, count] of [...catCount.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = (count / totalReqs * 100).toFixed(1);
    console.log(`  ${cat.padEnd(10)} ${fmt(count).padStart(6)} (${pct}%)`);
}

// Signal: how much of DeepSeek's requests hit an enriched tool vs unknown.
const enrichedRequested = requestOrder.filter(n => enrichedTools.has(n));
const unknownRequested = requestOrder.filter(n => !enrichedTools.has(n) && !passedThrough.has(n));
console.log('\nSignal (does enrichment reach the tools DeepSeek picks?):');
console.log(`  requested & catalog-enriched : ${fmt(enrichedRequested.length)}`);
console.log(`  requested & not-in-catalog   : ${fmt(unknownRequested.length)}`);
if (requests.size > 0) {
    console.log(`  coverage of actual usage     : ${(enrichedRequested.length / requestOrder.length * 100).toFixed(1)}%`);
}
