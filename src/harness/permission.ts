/**
 * Harness command permission classifier (v0.7.85) — a fail-closed gate for
 * shell commands run by the built-in agent harness (`Nikas: Run Agent`).
 *
 * PURE + vscode-free (unit-testable from plain Node, see test-permission.js).
 * Ports the heuristic pre-pass of grok-build's auto-mode permission
 * classifier (`auto_mode/mod.rs`): a deterministic layered gate that ALLOWS
 * routine read/build commands, BLOCKS dangerous patterns, and returns 'ask'
 * (→ fail-closed, treated as blocked) for anything it can't prove safe.
 *
 * Scope: this gates ONLY the harness's own run_terminal/run_tests tools. The
 * live Copilot chat path is untouched — there Copilot owns the permission
 * gate (auto-approve) and Nikas never executes tools.
 */

export type CommandTier = 'allow' | 'block' | 'ask';

export interface CommandVerdict {
    allowed: boolean;
    tier: CommandTier;
    reason: string;
}

export interface ClassifyOptions {
    /** Optional recent transcript (e.g. the agent's message history) scanned for hostile intent. */
    transcript?: string;
    /** When true, 'ask' verdicts are treated as blocked (fail-closed). Default true. */
    failClosed?: boolean;
}

// ── Dangerous patterns (blocklist, checked FIRST — fail-closed) ────────────
// Mirrors grok-build's dangerous-pattern blocklist.
const DANGEROUS_PATTERNS: { re: RegExp; why: string }[] = [
    { re: /\brm\s+-rf?\s+\/(?:\s|$)/, why: 'recursive delete of filesystem root' },
    { re: /\brm\s+-rf?\b/, why: 'recursive delete' },
    { re: /\bmkfs(?:\.[a-z0-9]+)?\b/, why: 'filesystem formatting' },
    { re: /\bdd\s+if=/, why: 'raw block-device write' },
    { re: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/, why: 'pipe remote content into a shell' },
    { re: /\bbase64\s+-d[^|;&]*\|\s*(?:ba)?sh\b/, why: 'decode-then-execute pipeline' },
    { re: /\bnc\s+-[a-z]*e\b/, why: 'netcat reverse shell' },
    { re: /\/dev\/tcp\//, why: 'bash /dev/tcp backdoor' },
    { re: /\bchmod\s+777\b/, why: 'world-writable permission change' },
    { re: /\bchown\b/, why: 'ownership change' },
    { re: /\bshutdown\b|\bpoweroff\b|\breboot\b|\bhalt\b/, why: 'system power control' },
    { re: /\bexfiltrat/i, why: 'data exfiltration' },
    { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;/, why: 'fork bomb' },
    { re: /\b(?:mkfs|fdisk|parted)\b/, why: 'disk partitioning/formatting' },
    { re: /\bformat\s+[a-z]:/i, why: 'drive formatting' },
    { re: /\b>\s*\/dev\/(?:sda|sdb|sdc|nvme)/, why: 'raw device write' },
    { re: /\bsudo\s+(?:rm|shutdown|poweroff|mkfs|dd|chmod|chown|useradd|deluser|passwd|visudo)\b/, why: 'privileged destructive command' },
    { re: /\bgit\s+push\s+--force\b|\bgit\s+push\s+-f\b/, why: 'force push' },
    { re: /\bdocker\s+(?:rm|rmi|volume\s+rm|system\s+prune)\b/, why: 'docker destructive command' },
];

// ── Environment-injection guard ────────────────────────────────────────────
// Setting these env vars inline can hijack child processes.
const ENV_INJECTION_PATTERNS: RegExp[] = [
    /\b(?:LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|BASH_ENV|ENV|IFS|PROMPT_COMMAND|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|GIT_CONFIG_(?:GLOBAL|SYSTEM|COUNT)|DYLD_(?:INSERT_LIBRARIES|LIBRARY_PATH))\s*=/,
    /\bPATH\s*=\s*/,
];

// ── Routine prefixes (allowlist — checked after dangerous patterns) ────────
const ROUTINE_PREFIXES: RegExp[] = [
    /^(?:ls|pwd|whoami|id|date|uname|echo|true|false|:)\b/,
    /^cat\s+/,
    /^head\s+/,
    /^tail\s+/,
    /^(?:rg|grep|ag|ack)\b/,
    /^diff\b/,
    /^jq\b/,
    /^find\s+[^\s]+\s+-name\b/,
    /^git\s+(?:status|diff|log|show|branch|checkout|switch|stash|pull|fetch|add|commit|merge|rebase|remote|rev-parse|ls-files|tag|describe|shortlog|blame)\b/,
    /^git\s+worktree\s+list\b/,
    /^(?:npm|yarn|pnpm)\s+(?:test|run|install|ci|build|tsc|lint|exec|audit|list|outdated|why)\b/,
    /^npx\s+(?:tsc|eslint|prettier|vitest|jest|mocha|jasmine|vite|webpack|rollup|jest|ts-node)\b/,
    /^python(?:3)?\s+(?:-m\s+)?(?:pytest|unittest|pip|venv)\b/,
    /^python(?:3)?\s+[a-zA-Z0-9_./-]+\.py\b/,
    /^node\s+(?:--)?[a-zA-Z0-9_./-]+\.(?:js|mjs|cjs|ts)\b/,
    /^(?:make|cmake|ninja)\b/,
    /^cargo\s+(?:build|check|test|run|clippy|fmt|metadata|tree|search|info|add|remove)\b/,
    /^go\s+(?:build|test|run|vet|fmt|mod|list|env)\b/,
    /^rustc\b/,
    /^dotnet\s+(?:build|test|run|restore|list|format)\b/,
    /^java\s+(?:-version\b|-jar\b)/,
    /^mvn\s+(?:test|compile|package|verify|clean|install)\b/,
    /^gradle\s+(?:test|compile|build|clean)\b/,
    /^docker\s+(?:build|images|ps|logs|pull|run|exec|compose)\b/,
    /^docker\s+compose\s+(?:up|down|build|ps|logs|config)\b/,
    /^kubectl\s+(?:get|describe|logs|version|explain|top|api-resources|cluster-info)\b/,
    /^gh\s+(?:auth|api|repo\s+(?:view|list)|issue\s+(?:list|view|status)|pr\s+(?:list|view|status|diff)|release\s+(?:list|view)|search|gist\s+list|run\s+(?:list|view))\b/,
    /^gitlab\b/,
    /^terraform\s+(?:init|plan|validate|fmt|version)\b/,
    /^ansible\s+(?:--version|config)\b/,
    /^curl\b[^|;&]*['"]?https?:/,
    /^wget\b[^|;&]*['"]?https?:/,
    /^env\s+[A-Za-z_][A-Za-z0-9_]*=/,
    /^export\s+[A-Za-z_][A-Za-z0-9_]*=/,
];

// ── Hostile-intent transcript scan ─────────────────────────────────────────
const HOSTILE_INTENT_PATTERNS: RegExp[] = [
    /delete\s+(?:all\s+)?files/i,
    /wipe\s+(?:the\s+)?disk/i,
    /exfiltrat/i,
    /steal\s+secrets/i,
    /ignore\s+safety/i,
    /bypass\s+permission/i,
    /disable\s+(?:the\s+)?(?:firewall|antivirus|security)/i,
    /rm\s+-rf\s+\//,
];

// ── Remote launchers (always block — fail-closed) ─────────────────────────
const REMOTE_LAUNCHERS: RegExp[] = [
    /^\s*npx\s+[a-zA-Z0-9@._-]+\s/,
    /^\s*(?:bunx|dlx|uvx|uv\s+tool\s+run|pipx\s+run)\s/,
    /^\s*npm\s+(?:exec|dlx)\s/,
];

// ── Read-only subcommand tables (kubectl / gh) ────────────────────────────
const READONLY_KUBECTL = /^kubectl\s+(get|describe|logs|version|explain|top|api-resources|cluster-info|auth)\b/;
const READONLY_GH = /^gh\s+(auth\s+status|api|repo\s+(view|list)|issue\s+(list|view|status)|pr\s+(list|view|status|diff)|release\s+(list|view)|search|gist\s+list|run\s+(list|view))\b/;

/** Plain `rm file` / `rm -f file` is allowed; recursive/root deletes are blocked. */
const PLAIN_RM = /^\s*rm\s+(?:-[a-zA-Z]*[^r][a-zA-Z]*\s+)?[^\s/][^\s]*(\s+[^\s/][^\s]*)*\s*$/;

/**
 * Classify a shell command (fail-closed).
 *
 * Order of checks (mirrors grok-build):
 *  1. Exact no-ops → allow.
 *  2. Dangerous patterns → block.
 *  3. Env-injection → block.
 *  4. Hostile intent in transcript → block.
 *  5. kubectl / gh non-readonly → block; readonly → allow.
 *  6. Routine allowlist → allow.
 *  7. Plain rm of files → allow.
 *  8. Remote launchers → block.
 *  9. Anything else → ask (fail-closed → blocked unless failClosed=false).
 */
export function classifyCommand(command: string, opts: ClassifyOptions = {}): CommandVerdict {
    const failClosed = opts.failClosed ?? true;
    const cmd = String(command ?? '').trim();
    if (!cmd) {
        return { allowed: false, tier: 'block', reason: 'empty command' };
    }

    // 1. Exact no-ops.
    if (/^(?:true|false|:)\s*$/.test(cmd)) {
        return { allowed: true, tier: 'allow', reason: 'no-op' };
    }

    // 2. Dangerous patterns.
    for (const p of DANGEROUS_PATTERNS) {
        if (p.re.test(cmd)) {
            return { allowed: false, tier: 'block', reason: `blocked: ${p.why}` };
        }
    }

    // 3. Env-injection guard.
    for (const re of ENV_INJECTION_PATTERNS) {
        if (re.test(cmd)) {
            return { allowed: false, tier: 'block', reason: 'blocked: environment injection' };
        }
    }

    // 4. Hostile intent in the transcript.
    if (opts.transcript) {
        for (const re of HOSTILE_INTENT_PATTERNS) {
            if (re.test(opts.transcript)) {
                return { allowed: false, tier: 'block', reason: 'blocked: hostile intent in conversation' };
            }
        }
    }

    // 5. kubectl / gh read-only tables (write/mutating forms always blocked).
    if (/^kubectl\b/.test(cmd)) {
        if (READONLY_KUBECTL.test(cmd)) return { allowed: true, tier: 'allow', reason: 'kubectl read-only' };
        return { allowed: false, tier: 'block', reason: 'blocked: kubectl write/mutating command' };
    }
    if (/^gh\b/.test(cmd)) {
        if (READONLY_GH.test(cmd)) return { allowed: true, tier: 'allow', reason: 'gh read-only' };
        return { allowed: false, tier: 'block', reason: 'blocked: gh write/mutating command' };
    }

    // 6. Routine allowlist.
    for (const re of ROUTINE_PREFIXES) {
        if (re.test(cmd)) {
            return { allowed: true, tier: 'allow', reason: 'routine command' };
        }
    }

    // 7. Plain rm of explicit files (no -r, no absolute root).
    if (PLAIN_RM.test(cmd)) {
        return { allowed: true, tier: 'allow', reason: 'plain file removal' };
    }

    // 8. Remote launchers (always block — fail-closed).
    for (const re of REMOTE_LAUNCHERS) {
        if (re.test(cmd)) {
            return { allowed: false, tier: 'block', reason: 'blocked: remote package launcher' };
        }
    }

    // 9. Anything unproven → ask (fail-closed by default).
    if (failClosed) {
        return { allowed: false, tier: 'ask', reason: 'unrecognized command (fail-closed)' };
    }
    return { allowed: true, tier: 'ask', reason: 'unrecognized command (ask)' };
}

/** Default gate for the harness: classifyCommand with the recent transcript. */
export function defaultPermissionGate(command: string, transcript?: string): CommandVerdict {
    return classifyCommand(command, { transcript, failClosed: true });
}

/** Tool names that run shell commands (gated by the permission classifier). */
export function isTerminalTool(name: string): boolean {
    return name === 'run_terminal' || name === 'run_tests' || name === 'run_verify';
}
