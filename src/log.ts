import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Simple file-based logger for Nika extension errors.
 *
 * Writes to `nika.log` in the workspace root (first workspace folder).
 * Falls back to the extension's global storage path if no workspace is open.
 *
 * Log format: [ISO timestamp] [LEVEL] message
 * Stack traces are included when available.
 */

const LOG_FILE_NAME = 'nika.log';

let logFilePath: string | null = null;

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

function writeLine(level: string, message: string, err?: unknown): void {
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

        // Append to file (create if doesn't exist)
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
};

/** Get the current log file path (for display to the user). */
export function getLogFilePath(): string {
    return resolveLogPath();
}
