#!/usr/bin/env node
/**
 * ab-thinking.js — A/B compare DeepSeek code-quality across thinking efforts.
 *
 * Runs the SAME code-contract benchmark (from test-hallucination.js) at
 * thinking=off / high / max and prints a side-by-side table, so you can decide
 * whether thinking mode is worth the cost for agent work.
 *
 * It uses the Responses API (the path Nikas actually uses for
 * deepseek-v4-flash-responses) and a SMALL fill level by default so results
 * come back fast. Increase --fills / --tasks for more statistical confidence.
 *
 * USAGE (set the key in the terminal — never paste it into chat):
 *   $env:DEEPSEEK_API_KEY="sk-..." ; node ab-thinking.js
 *
 * OPTIONS:
 *   --fills=10,50,90   fill levels to probe (default 20,60)
 *   --tasks=2          code tasks per (fill × effort) cell (default 2)
 *   --efforts=off,high,max   which efforts to compare (default all three)
 *   --window=1000000   context window preset
 *   --json             emit machine-readable JSON at the end
 */
const { execFileSync } = require('child_process');
const path = require('path');

const HARNESS = path.join(__dirname, 'test-hallucination.js');

function parseArgs(argv) {
    const opts = {
        fills: [20, 60],
        tasks: 2,
        efforts: ['off', 'high', 'max'],
        window: 1000000,
        json: false,
    };
    for (const a of argv) {
        if (a.startsWith('--fills=')) opts.fills = a.slice(8).split(',').map(Number).filter(n => !isNaN(n));
        else if (a.startsWith('--tasks=')) opts.tasks = parseInt(a.slice(8), 10);
        else if (a.startsWith('--efforts=')) opts.efforts = a.slice(10).split(',');
        else if (a.startsWith('--window=')) opts.window = parseInt(a.slice(9), 10);
        else if (a === '--json') opts.json = true;
    }
    return opts;
}

function runEffort(opts, effort) {
    // The harness's runScan prints its own per-fill table. We capture stdout.
    const args = [
        HARNESS,
        '--api=responses',
        `--thinking=${effort}`,
        `--fills=${opts.fills.join(',')}`,
        `--tasks=${opts.tasks}`,
        `--window=${opts.window}`,
        '--scenario=code',
    ];
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', env: process.env });
    return stdout;
}

function extractCompliance(stdout, fills) {
    // The harness prints a summary table (non-dry code scan):
    //   fill%   ~tokens       compliance  status
    //   20      197,794       85          OK
    // Row = fill number, token count (with commas), compliance number, status.
    const map = {};
    for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+[\d,]+\s+(\d+)\s+\S+/);
        if (m) map[Number(m[1])] = Number(m[2]);
    }
    return map;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!process.env.DEEPSEEK_API_KEY) {
        console.error('ERROR: set DEEPSEEK_API_KEY in the terminal first, e.g.');
        console.error('  $env:DEEPSEEK_API_KEY="sk-..." ; node ab-thinking.js');
        process.exit(1);
    }

    const results = {};
    for (const effort of opts.efforts) {
        console.log(`\n=== Thinking: ${effort} ===`);
        const out = runEffort(opts, effort);
        console.log(out);
        results[effort] = extractCompliance(out, opts.fills);
    }

    console.log('\n\n===== A/B SUMMARY (code contract compliance %) =====');
    const header = ['effort', ...opts.fills.map(f => `fill ${f}%`)].join('\t');
    console.log(header);
    for (const effort of opts.efforts) {
        const row = [effort, ...opts.fills.map(f => results[effort]?.[f] ?? 'n/a')].join('\t');
        console.log(row);
    }

    if (opts.json) {
        console.log('\nJSON:');
        console.log(JSON.stringify({ fills: opts.fills, results }, null, 2));
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
