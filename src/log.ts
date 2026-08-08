import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getLogMaxFiles, getLogMaxSizeMB, type LogLevel } from './config.js';

/**
 * File-based logger for Nikas with level filtering.
 *
 * Writes to `nikas.log` in the workspace root (first workspace folder).
 * Falls back to the extension's global storage path if no workspace is open.
 *
 * Log format: [ISO timestamp] [LEVEL] message
 * Stack traces are included when available.
 *
 * Log levels (increasing verbosity):
 *   OFF     — No logging at all (completely silent)
 *   ERROR   — Only errors (crashes, API failures)
 *   WARN    — Warnings (misconfigurations, recoverable issues)
 *   INFO    — Normal operational messages (requests sent, models used) [default]
 *   VERBOSE — Detailed debugging (full request/response bodies, message dumps)
 */

// Numeric values for comparison
const LEVEL_NUM: Record<LogLevel, number> = {
    OFF: -1,
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    VERBOSE: 3,
};

const LOG_FILE_NAME = 'nikas.log';

let logFilePath: string | null = null;
let currentLevel: LogLevel = 'INFO';

function resolveLogPath(): string {
    if (logFilePath) return logFilePath;

    // Prefer workspace root so the log is visible to the user
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        logFilePath = path.join(workspaceFolders[0].uri.fsPath, LOG_FILE_NAME);
    } else {
        // Fallback: write next to the extension's out/ directory
        logFilePath = path.join(__dirname, '..', LOG_FILE_NAME);
    }

    return logFilePath;
}

function formatTimestamp(): string {
    return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
    return LEVEL_NUM[level] <= LEVEL_NUM[currentLevel];
}

/**
 * Rotate `nikas.log` when it exceeds the configured max size, so it can
 * never grow to gigabytes. Uses `nikas.log.1`, `.2`, ... up to the
 * configured max file count, then prunes the oldest.
 */
function rotateIfNeeded(filePath: string): void {
    try {
        const maxBytes = getLogMaxSizeMB() * 1024 * 1024;
        if (maxBytes <= 0) return; // size-based rotation disabled

        const stat = fs.statSync(filePath);
        if (stat.size < maxBytes) return; // still under the limit

        const maxFiles = getLogMaxFiles();
        if (maxFiles <= 0) {
            // No backups wanted — just truncate the log in place.
            fs.writeFileSync(filePath, '');
            return;
        }

        // Prune the oldest rotated file (highest index).
        const oldest = `${filePath}.${maxFiles}`;
        try { fs.unlinkSync(oldest); } catch { /* ignore */ }

        // Shift rotated files down: .N-1 -> .N, ... .1 -> .2
        for (let i = maxFiles - 1; i >= 1; i--) {
            try {
                fs.renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
            } catch { /* ignore */ }
        }

        // Rotate the current log -> .1
        try {
            fs.renameSync(filePath, `${filePath}.1`);
        } catch { /* ignore */ }
    } catch {
        // File doesn't exist yet or other error — nothing to rotate.
    }
}

function writeLine(level: LogLevel, message: string, err?: unknown): void {
    if (!shouldLog(level)) return;

    try {
        const filePath = resolveLogPath();
        const timestamp = formatTimestamp();
        let line = `[${timestamp}] [${level}] ${message}`;

        if (err instanceof Error) {
            line += `\n  Error: ${err.message}`;
            if (err.stack) {
                // Indent stack for readability
                const stackLines = err.stack.split('\n').slice(1).map(l => `  ${l.trim()}`).join('\n');
                line += `\n${stackLines}`;
            }
        } else if (err !== undefined && err !== null) {
            line += `\n  Details: ${String(err)}`;
        }

        line += '\n';

        // Rotate first if the log has grown too large, then append.
        rotateIfNeeded(filePath);
        fs.appendFileSync(filePath, line, 'utf-8');
    } catch {
        // Silently ignore logging failures — don't compound errors
    }
}

export const log = {
    error(message: string, err?: unknown): void {
        writeLine('ERROR', message, err);
    },

    warn(message: string, err?: unknown): void {
        writeLine('WARN', message, err);
    },

    info(message: string): void {
        writeLine('INFO', message);
    },

    verbose(message: string, err?: unknown): void {
        writeLine('VERBOSE', message, err);
    },
};

/** Set the current log level. Returns the previous level. */
export function setLogLevel(level: LogLevel): LogLevel {
    const prev = currentLevel;
    currentLevel = level;
    return prev;
}

/** Get the current log level. */
export function getLogLevel(): LogLevel {
    return currentLevel;
}

/** Get the current log file path (for display to the user). */
export function getLogFilePath(): string {
    return resolveLogPath();
}
