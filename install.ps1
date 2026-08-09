# Nikas - One-click installer
# ============================
# Double-click (or right-click -> "Run with PowerShell") to install Nikas.
# This script finds the .vsix next to itself, verifies it, and installs it
# into VS Code / Cursor using the correct absolute path — avoiding the
# "no such file or directory" error that happens when you run `code
# --install-extension` from the wrong folder.
#
# Usage:
#   .\install.ps1                # install with default (VS Code)
#   .\install.ps1 -Editor cursor # install into Cursor instead
#   .\install.ps1 -Vsix C:\path\to\nikas-x.y.z.vsix
#
# The .vsix file MUST be in the same folder as this script (unless you pass -Vsix).

param(
    [string]$Vsix = "",
    [ValidateSet("code", "cursor", "windsurf", "vscodium")]
    [string]$Editor = "code"
)

$ErrorActionPreference = "Stop"

# --- Locate the .vsix file ------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($Vsix)) {
    # Prefer the newest nikas-*.vsix in this folder.
    $candidates = Get-ChildItem -Path $scriptDir -Filter "nikas-*.vsix" -File | Sort-Object LastWriteTime -Descending
    if ($candidates.Count -eq 0) {
        Write-Host "ERROR: No nikas-*.vsix file found in: $scriptDir" -ForegroundColor Red
        Write-Host "Put the .vsix file in the same folder as install.ps1, or pass -Vsix <path>." -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 1
    }
    $Vsix = $candidates[0].FullName
}

$Vsix = (Resolve-Path $Vsix).Path
if (-not (Test-Path $Vsix)) {
    Write-Host "ERROR: The .vsix file does not exist: $Vsix" -ForegroundColor Red
    Write-Host "Check that you copied the file to this machine and the path is correct." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# --- Validate the file looks sane -----------------------------------------
$size = (Get-Item $Vsix).Length
Write-Host "Installing: $Vsix" -ForegroundColor Cyan
Write-Host "Size: $([math]::Round($size / 1KB, 1)) KB"

if ($size -lt 50000) {
    Write-Host "WARNING: The file is suspiciously small ($([math]::Round($size/1KB,1)) KB)." -ForegroundColor Yellow
    Write-Host "A valid Nikas build is ~114 KB. The file may have been truncated during transfer." -ForegroundColor Yellow
    Write-Host "Re-copy the .vsix file and try again." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# --- Find the editor CLI ---------------------------------------------------
$cli = Get-Command $Editor -ErrorAction SilentlyContinue
if (-not $cli) {
    Write-Host "ERROR: Could not find the '$Editor' command on your PATH." -ForegroundColor Red
    Write-Host "For VS Code: open it, press Ctrl+Shift+P, run 'Shell Command: Install 'code' command in PATH'." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# --- Install ---------------------------------------------------------------
Write-Host "Installing into $Editor ..." -ForegroundColor Cyan
& $cli --install-extension $Vsix --force
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS! Nikas was installed." -ForegroundColor Green
    Write-Host "Next steps:" -ForegroundColor Green
    Write-Host "  1. Reload / restart $Editor" -ForegroundColor White
    Write-Host "  2. Click the 'Nikas: Set up' status bar item (bottom-left)" -ForegroundColor White
    Write-Host "  3. Paste your DeepSeek API key and pick a model" -ForegroundColor White
} else {
    Write-Host ""
    Write-Host "INSTALL FAILED (exit code $exitCode)." -ForegroundColor Red
    Write-Host "Copy the error message above and send it to whoever gave you this file." -ForegroundColor Yellow
}

Read-Host "Press Enter to exit"
