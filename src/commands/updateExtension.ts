import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from '../log.js';

/**
 * Update command — checks GitHub Releases for a newer version,
 * downloads the .vsix, installs it, and prompts to reload.
 *
 * Flow:
 * 1. Fetch latest release from GitHub API
 * 2. Compare semver with current version
 * 3. Download .vsix to a temp file
 * 4. Install via VS Code extension install command
 * 5. Prompt to reload window
 */

const GITHUB_API = 'https://api.github.com/repos/alive2/nika/releases/latest';
const USER_AGENT = 'nika-vscode-extension';

interface GitHubRelease {
    tag_name: string;
    name: string;
    html_url: string;
    body: string;
    assets: Array<{
        name: string;
        browser_download_url: string;
        size: number;
    }>;
}

/**
 * Parse a semver-ish string (e.g., "v0.3.3" or "0.3.3") into [major, minor, patch].
 */
function parseVersion(v: string): [number, number, number] {
    const cleaned = v.replace(/^v/, '');
    const parts = cleaned.split('.').map(Number);
    return [
        parts[0] || 0,
        parts[1] || 0,
        parts[2] || 0,
    ];
}

/**
 * Compare two semver tuples. Returns positive if a > b, negative if a < b, 0 if equal.
 */
function compareVersions(a: [number, number, number], b: [number, number, number]): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

export async function checkForUpdates(context: vscode.ExtensionContext): Promise<void> {
    const currentVersion = context.extension.packageJSON.version as string;
    const currentParsed = parseVersion(currentVersion);

    // Fetch latest release info
    let release: GitHubRelease;
    try {
        release = await fetchLatestRelease();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Failed to check for updates', err);
        vscode.window.showErrorMessage(`Nika: Failed to check for updates: ${msg}`);
        return;
    }

    const latestParsed = parseVersion(release.tag_name);

    if (compareVersions(latestParsed, currentParsed) <= 0) {
        vscode.window.showInformationMessage(
            `Nika v${currentVersion} is up to date.`
        );
        return;
    }

    // New version available — ask user
    const releaseVersion = release.tag_name.replace(/^v/, '');
    const download = 'Download & Install';
    const viewRelease = 'View Release Notes';
    const choice = await vscode.window.showInformationMessage(
        `Nika v${releaseVersion} is available (you have v${currentVersion}). Update now?`,
        { modal: false },
        download,
        viewRelease
    );

    if (choice === viewRelease) {
        vscode.env.openExternal(vscode.Uri.parse(release.html_url));
        return;
    }

    if (choice !== download) return;

    // Find the .vsix asset
    const vsixAsset = release.assets.find(a => a.name.endsWith('.vsix'));
    if (!vsixAsset) {
        vscode.window.showErrorMessage(
            'Nika: No .vsix asset found in the latest release. Please install manually from the releases page.'
        );
        return;
    }

    // Download to temp file
    const tmpDir = os.tmpdir();
    const vsixPath = path.join(tmpDir, vsixAsset.name);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Downloading Nika v${releaseVersion}...`,
            cancellable: true,
        },
        async (progress, token) => {
            try {
                await downloadFile(vsixAsset.browser_download_url, vsixPath, progress, token);
            } catch (err) {
                if (token.isCancellationRequested) return;

                const msg = err instanceof Error ? err.message : String(err);
                log.error('Failed to download update', err);
                vscode.window.showErrorMessage(`Nika: Download failed: ${msg}`);

                // Clean up partial download
                try { fs.unlinkSync(vsixPath); } catch { /* ignore */ }
                return;
            }

            // Install the .vsix
            try {
                const vsixUri = vscode.Uri.file(vsixPath);
                await vscode.commands.executeCommand(
                    'workbench.extensions.installExtension',
                    vsixUri
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error('Failed to install update', err);
                vscode.window.showErrorMessage(`Nika: Install failed: ${msg}`);
                try { fs.unlinkSync(vsixPath); } catch { /* ignore */ }
                return;
            }

            // Clean up temp .vsix
            try { fs.unlinkSync(vsixPath); } catch { /* ignore */ }

            // Prompt to reload
            const reload = await vscode.window.showInformationMessage(
                `Nika v${releaseVersion} installed! Reload window to activate.`,
                'Reload Now'
            );

            if (reload === 'Reload Now') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }
    );
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
    const response = await fetch(GITHUB_API, {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/vnd.github+json',
        },
    });

    if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
            throw new Error(
                'GitHub API rate limit reached. Please try again later or update manually from the releases page.'
            );
        }
        throw new Error(`GitHub API returned HTTP ${response.status}`);
    }

    return response.json() as Promise<GitHubRelease>;
}

async function downloadFile(
    url: string,
    destPath: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
): Promise<void> {
    const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
    });

    if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('No response body');
    }

    const chunks: Uint8Array[] = [];
    let downloaded = 0;

    while (true) {
        if (token.isCancellationRequested) {
            reader.cancel();
            return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        downloaded += value.length;

        if (total > 0) {
            const pct = Math.round((downloaded / total) * 100);
            const mb = (downloaded / (1024 * 1024)).toFixed(1);
            const totalMb = (total / (1024 * 1024)).toFixed(1);
            progress.report({
                message: `${mb} / ${totalMb} MB (${pct}%)`,
                increment: 0,
            });
        }
    }

    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(destPath, buffer);
}
