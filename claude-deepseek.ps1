# claude-deepseek.ps1
#
# Configure Claude Code CLI to use DeepSeek V4 as its backend model.
#
# Based on DeepSeek's official agent-integration guide:
#   https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
#
# Settings used:
#   - ANTHROPIC_BASE_URL          https://api.deepseek.com/anthropic (DeepSeek's
#                                 Anthropic-compatible endpoint)
#   - ANTHROPIC_AUTH_TOKEN        your DeepSeek API key
#   - ANTHROPIC_MODEL             deepseek-v4-pro[1m]   (main model, 1M window)
#   - OPUS/SONNET/HAIKU mapping   pro[1m] / pro[1m] / flash (DeepSeek maps
#                                 sonnet/haiku -> flash, opus -> pro)
#   - CLAUDE_CODE_SUBAGENT_MODEL  deepseek-v4-flash     (fast subagents)
#   - CLAUDE_CODE_EFFORT_LEVEL    max                   (deep reasoning)
#   - CLAUDE_CODE_AUTO_COMPACT_WINDOW  786432  <-- DeepSeek's official
#                                 recommendation; matches the ~800K real-token
#                                 quality limit measured for DeepSeek V4 on the
#                                 1M window (Nikas harness, 2026-08-09).
#
# USAGE
#   Run once per terminal, then `claude` in your project folder:
#       .\claude-deepseek.ps1
#       claude
#
#   The script prompts for your DeepSeek API key the first time (or reads
#   $env:DEEPSEEK_API_KEY if already set) and stores it in the user profile
#   so future terminals pick it up automatically.
#
#   To undo: remove the NIKAS_CLAUDE block from your PowerShell $PROFILE.

param(
    [switch]$KeyOnly  # only (re)set the API key, skip the model env vars
)

$ErrorActionPreference = 'Stop'

# ── 1. API key ──────────────────────────────────────────────────────────
$persistedKey = "$env:USERPROFILE\.nikas-claude-key"
if (-not $env:DEEPSEEK_API_KEY -and (Test-Path $persistedKey)) {
    $env:DEEPSEEK_API_KEY = (Get-Content $persistedKey -Raw).Trim()
}

if (-not $env:DEEPSEEK_API_KEY) {
    Write-Host "Enter your DeepSeek API key (from https://platform.deepseek.com/api_keys):" -ForegroundColor Cyan
    $env:DEEPSEEK_API_KEY = Read-Host -AsSecureString
    # Read-Host -AsSecureString returns a SecureString in some PS versions;
    # ConvertFrom-SecureString below is cross-version safe.
    $env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', $env:DEEPSEEK_API_KEY).Password
}

if (-not $env:DEEPSEEK_API_KEY) {
    Write-Error "No API key provided. Aborting."
    exit 1
}

# Persist it (mode 600 on the file, like a keychain-lite) so future terminals
# don't need to re-enter it. The key never goes into any committed file.
Set-Content -Path $persistedKey -Value $env:DEEPSEEK_API_KEY -NoNewline
Write-Host "API key ready." -ForegroundColor Green

if ($KeyOnly) { exit 0 }

# ── 2. DeepSeek model env vars for Claude Code ─────────────────────────
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
$env:ANTHROPIC_AUTH_TOKEN = $env:DEEPSEEK_API_KEY
$env:ANTHROPIC_MODEL = "deepseek-v4-pro[1m]"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro[1m]"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-v4-pro[1m]"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash"
$env:CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-v4-flash"
$env:CLAUDE_CODE_EFFORT_LEVEL = "max"
# DeepSeek's official recommendation — matches the measured ~800K real-token
# quality limit for DeepSeek V4 on a 1M window.
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "786432"

Write-Host ""
Write-Host "Claude Code is now pointed at DeepSeek V4:" -ForegroundColor Green
Write-Host "  main model   : $env:ANTHROPIC_MODEL"
Write-Host "  subagent     : $env:CLAUDE_CODE_SUBAGENT_MODEL"
Write-Host "  effort       : $env:CLAUDE_CODE_EFFORT_LEVEL"
Write-Host "  auto-compact : $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW tokens (official DeepSeek recommendation)"
Write-Host ""
Write-Host "Run 'claude' in your project folder to start. Note: these env vars"
Write-Host "apply to THIS terminal only. Re-run this script in a new terminal."
