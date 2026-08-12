/**
 * Minimal agent toolset — the tools a self-contained agent harness can call.
 *
 * This mirrors, at small scale, the workspace-integrated tool categories
 * Copilot exposes (file read/write, search, terminal). Each tool is described
 * for the model (name/description/parameters) AND has an executor that runs
 * it against the local filesystem / shell.
 *
 * Deliberately small and dependency-free (Node fs + child_process) so the
 * whole harness is testable. Executors never throw — they return a structured
 * result string so the agent loop can feed it straight back to the model.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

export interface AgentTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /** Execute the tool. Must resolve to a string (success or error). */
    execute(args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<string>;
}

function argString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    return typeof v === 'string' ? v : '';
}

function safeRead(file: string, cwd: string): string {
    const p = path.resolve(cwd, file);
    try {
        const content = fs.readFileSync(p, 'utf8');
        // Cap returned content to avoid blowing the context window.
        const MAX = 60_000;
        return content.length > MAX ? content.slice(0, MAX) + `\n...[truncated ${content.length - MAX} chars]` : content;
    } catch (err) {
        return `[error reading ${p}: ${err instanceof Error ? err.message : String(err)}]`;
    }
}

export const FILE_READ: AgentTool = {
    name: 'read_file',
    description: 'Read the contents of a file from disk. Returns up to ~60K chars.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (args, cwd) => safeRead(argString(args, 'path'), cwd),
};

export const FILE_WRITE: AgentTool = {
    name: 'write_file',
    description: 'Write content to a file (creates parent dirs). Overwrites if it exists.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string' },
            content: { type: 'string' },
        },
        required: ['path', 'content'],
    },
    execute: async (args, cwd) => {
        const p = path.resolve(cwd, argString(args, 'path'));
        const content = argString(args, 'content');
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content, 'utf8');
            return `[wrote ${content.length} chars to ${p}]`;
        } catch (err) {
            return `[error writing ${p}: ${err instanceof Error ? err.message : String(err)}]`;
        }
    },
};

export const SEARCH: AgentTool = {
    name: 'search_text',
    description: 'Grep for a text pattern across files in a directory (recursive, case-insensitive).',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string' },
            dir: { type: 'string' },
        },
        required: ['pattern'],
    },
    execute: async (args, cwd) => {
        const pattern = argString(args, 'pattern');
        const dir = argString(args, 'dir') || '.';
        const base = path.resolve(cwd, dir);
        const hits: string[] = [];
        const MAX = 40;
        const walk = (d: string): void => {
            if (hits.length >= MAX) return;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(d, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                if (hits.length >= MAX) return;
                const full = path.join(d, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
                    walk(full);
                } else if (e.isFile()) {
                    try {
                        const text = fs.readFileSync(full, 'utf8');
                        if (text.toLowerCase().includes(pattern.toLowerCase())) {
                            hits.push(`${full}`);
                        }
                    } catch { /* skip unreadable */ }
                }
            }
        };
        walk(base);
        if (hits.length === 0) return `[no matches for '${pattern}' under ${base}]`;
        return hits.length > MAX
            ? hits.join('\n') + `\n...[${hits.length - MAX} more]`
            : hits.join('\n');
    },
};

export const TERMINAL: AgentTool = {
    name: 'run_terminal',
    description: 'Run a shell command in the working directory. Returns stdout+stderr (capped).',
    parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
    },
    execute: async (args, cwd, signal) => {
        const command = argString(args, 'command');
        return new Promise<string>((resolve) => {
            if (signal?.aborted) {
                resolve('[command aborted]');
                return;
            }
            const child = cp.exec(
                command,
                { cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, signal },
                (err, stdout, stderr) => {
                    if (signal?.aborted || (err && err.killed)) {
                        resolve('[command aborted]');
                        return;
                    }
                    const cap = (s: string): string => (s.length > 8000 ? s.slice(0, 8000) + '...[truncated]' : s);
                    const out = cap(stdout.trim());
                    const errText = cap(stderr.trim());
                    if (err && !out) {
                        resolve(`[command failed]\n${errText || err.message}`);
                    } else {
                        resolve(out ? out : (errText || '(no output)'));
                    }
                }
            );
            signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
        });
    },
};

export const RUN_TESTS: AgentTool = {
    name: 'run_tests',
    description: 'Run the project test suite (e.g. `npm test`) and return its output. Use after making changes to verify nothing broke.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The test command to run. Defaults to `npm test`.' },
        },
    },
    execute: async (args, cwd, signal) => {
        const command = argString(args, 'command') || 'npm test';
        return TERMINAL.execute({ command }, cwd, signal);
    },
};

/** The default toolset the harness offers the model. */
export const DEFAULT_TOOLSET: AgentTool[] = [FILE_READ, FILE_WRITE, SEARCH, TERMINAL, RUN_TESTS];
