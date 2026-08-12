# Nikas

**DeepSeek language model provider for VS Code Copilot Chat**, with configurable vision preprocessing (Gemma 4 via Ollama or Gemini) **and automatic restoration of PDF support in Copilot Chat**.

Nikas is a fork of the [Nika](https://github.com/alive2/nika) extension. It adds DeepSeek V4 models to Copilot Chat's model picker (bring your own API key — no GitHub Copilot subscription required) and — unlike stock Copilot Chat — keeps **PDF attachments working for third-party providers** by automatically re-applying the Copilot Chat PDF patches whenever an update wipes them.

## Why this extension?

- **Don't replace Copilot — power it up.** No new sidebar, no new chat UI to learn. Just a new model in the picker you already use.
- **Agent mode, tool calling, instructions, MCP, skills — all of it still works.** Copilot's entire stack, now running on DeepSeek.
- **Vision on a text-only model.** DeepSeek V4 can't see images. This extension proxies any image you drop into chat through another Copilot model you already have, then feeds the description to DeepSeek — transparently.
- **BYOK, pay DeepSeek directly.** Your API key, your bill, your rate limits. Stored in the OS keychain, never on disk.

## Features

- **DeepSeek V4 Flash & Pro** — fast and powerful models in the Copilot Chat model picker
- **DeepSeek V4 Flash (Responses) — Nikas** — the same Flash 0731 model served through DeepSeek's newer Responses API (`POST /responses`), built for agent-native tooling
- **📄 PDF support that survives updates** — Copilot Chat drops PDF attachments for third-party providers. Nikas patches the installed Copilot Chat bundle (8 surgical patches: allow DeepSeek to receive PDFs, raise the 5 MB read limit to 100 MB, let PDFs bypass `omitContents`, drop the `supportsVision` gate, convert `Document` parts to `LanguageModelDataPart`, etc.) and **re-applies them automatically** after every Copilot Chat / VS Code update
- **Vision preprocessing** — send images in chat and they're automatically described by Gemma 4 (local, via Ollama) or Gemini 2.5 Flash (free tier), then forwarded to DeepSeek
- **Streaming responses** — real-time token-by-token output
- **Tool calling** — full support for VS Code's built-in tools (read files, run terminal commands, search, etc.)
- **Secure key storage** — API keys stored in your OS keychain, never in plaintext settings
- **📊 Usage & Cost dashboard** — per-conversation token usage and estimated cost (this session + all time, by provider, top sessions), surfaced in the status bar and a QuickPick report (`Nikas: Usage & Cost`). Purely observational — disabling `nikas.usageTracking` stops recording and hides the status bar item, never affecting chat behavior
- **🧠 Persistent session memory** — when a long conversation is compacted, the session-memory summary is saved to a per-workspace `nikas.md` (plus a reliable VS Code snapshot). If you reopen that conversation after a restart, Nikas re-injects the saved memory so you don't lose context. Purely additive — disabling `nikas.memoryPersistence` stops saving and injecting
- **⏱️ Context budget** — live warnings as a conversation approaches the context window (with configurable warn/critical fill% thresholds) and, when over budget, automatic reclaim of tokens by dropping low-value tool output before discarding your actual conversation. Purely additive — disabling `nikas.contextBudget` turns both off
- **🤖 Run Agent** — a built-in agent harness (`Nikas: Run Agent`) that runs a task through the full loop (category summarizer → tool scoping → model ↔ tools) in the current workspace, streaming to an output channel. Purely additive — disabling `nikas.agentCommand` hides the command and never affects chat
- **🗂️ PDF-vision cache** — sparse PDF vision pre-processing results are cached (bounded, keyed by prompt + content) so re-describing the same PDFs is served from cache instead of re-calling the vision model
- **🔀 Model router** — optionally route cheap internal helper requests (chat titles, git commit messages, todo tracking, etc.) to the faster Flash model even when Pro is selected. Off by default (`nikas.modelRouter`); never routes Responses-family model ids to `/chat/completions`. Auto mode (`nikas.modelRouterMode=auto`) additionally routes heavy agent tasks to Pro and quick chats to Flash
- **🛡️ Harness permission gate** — the built-in agent (`Nikas: Run Agent`) fail-closes terminal commands: dangerous patterns (root deletes, disk formatting, env injection, remote launchers, hostile intent) and unrecognized commands are blocked before they execute. Never affects Copilot's own permission flow
- **⚡ Harness tool cache** — read-only tool results (`read_file`/`search_text`) are deduped within a single agent run, so identical calls (including same-batch duplicates) execute once and are served from cache
- **⏹️ Cancellation propagation** — the agent harness now stops cleanly on abort: abort-aware retries, no new tool calls after cancel, and an `aborted` result instead of a thrown error
- **🔍 Structured image extraction** — image attachments are described with a structured OCR/layout prompt (verbatim text, tables as markdown, no invented content), and large image sets are described in sequential batches under the vision model's per-call image cap
- **⏱️ Latency telemetry** — per-request wall-clock latency is recorded and surfaced: the usage status bar shows the last request's latency, and the dashboard/report include a “Last request” breakdown
- **Local-first vision** — Gemma 4 runs on your own machine via Ollama, no cloud API key needed

## Quick Start

### 1. Install

**Easiest way — one-click installer (Windows):**
Put `install.ps1` and `nikas-0.7.11.vsix` in the **same folder**, then double-click
`install.ps1` (or right-click → *Run with PowerShell*). It finds the `.vsix` next to
itself, checks it's valid, and installs it with the correct path — no typing needed.

**Manual (command line):** use the **full path** to the `.vsix`. Running it from the
wrong folder causes the *"no such file or directory"* error.

```bash
# Correct — absolute path:
code --install-extension "C:\Users\You\Downloads\nikas-0.7.11.vsix"

# Wrong — fails with "no such file or directory" if the file isn't in the current folder:
code --install-extension nikas-0.7.11.vsix
```

> The `.vsix` is ~114 KB. If the file you received is much smaller, it was probably
> truncated during transfer — ask the sender to re-send it.

### 2. Run the setup wizard (recommended)

The moment the extension activates, a **status bar item** appears at the bottom-left.
If Nikas isn't configured yet it shows **"Nikas: Set up"** — click it (or run
`F1` → **`Nikas: Setup (First-Time Wizard)`**) to launch a guided wizard that walks
you through everything in one place:

1. **Set your DeepSeek API key** (required) — or click "Get a DeepSeek API Key" to open [platform.deepseek.com](https://platform.deepseek.com/) and create one.
2. **Choose a vision provider** (optional, for image support) — Gemini (cloud) or Gemma 4 (local).
3. **Choose a chat model** — defaults to DeepSeek V4 Flash.

Once you've set your API key, the status bar changes to **"Nikas: Ready"** ✅.

> If you skip the wizard, you can always reopen it anytime via
> `F1` → `Nikas: Setup (First-Time Wizard)`, or `F1` → `Manage Nikas Models` → `Setup Wizard`.

### 3. Select a chat model

1. Open Copilot Chat (`Ctrl+Shift+I`)
2. Click the model picker dropdown at the top
3. Select **DeepSeek V4 Flash**, **DeepSeek V4 Pro**, or **DeepSeek V4 Flash (Responses) — Nikas**
4. Start chatting

> **DeepSeek V4 Flash (Responses) — Nikas** uses DeepSeek's newer Responses API (`POST /responses`) instead of Chat Completions. It's selected via the Copilot model picker only (it's not part of `Nikas: Choose Provider`).

### Manual configuration (skip the wizard)

You only need a DeepSeek API key for chat. Vision is optional:

| Key / Setup | Where to get it | Purpose |
|---|---|---|
| DeepSeek API key | [platform.deepseek.com](https://platform.deepseek.com/) | Chat responses (required) |
| Gemma 4 via Ollama | `ollama pull gemma4:31b` | Vision preprocessing (local, default) |
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (free) | Vision preprocessing (cloud, alternative) |

Store the DeepSeek key:

- `F1` → `Manage Nikas Models` → `Input DeepSeek API Key`

#### Set up Gemma 4 (default)

Install Ollama and pull the model — no API key needed:

```bash
# Install Ollama from https://ollama.com, then:
ollama pull gemma4:31b
```

Nikas connects to Ollama at `http://localhost:11434` by default. To use a remote Ollama instance: `F1` → `Manage Nikas Models` → `Set Ollama Host`.

#### Set up Gemini (alternative)

1. `F1` → `Manage Nikas Models` → `Input Gemini API Key`
2. Paste your Gemini API key (`AIza...`)
3. `F1` → `Manage Nikas Models` → `Choose Vision Model` → pick **Gemini 2.5 Flash**

### 4. PDF support

Attach a PDF in chat and send it — it should reach DeepSeek as a document part. If a Copilot Chat / VS Code update wiped the patches, Nikas re-applies them automatically (you'll get a notification with a **Reload Now** button). To inspect or force it:

- `F1` → `Nikas: Copilot PDF Patch Status` — shows which of the 9 patches are applied
- `F1` → `Nikas: Re-apply Copilot PDF Patches` — forces a patch cycle now

The patcher writes the bundle to `...\resources\app\extensions\copilot\dist\extension.js` and keeps timestamped `.bak-*` backups (pruned after `nikas.patchBackupRetention`). All activity is logged to the **Nikas PDF Patcher** output channel and `nikas.log`.

> **When a patch can't auto-apply** (Copilot shipped a new bundle structure), the patcher
> logs a **diagnostic context window** around the affected code — a ~440-character snippet
> from the live bundle near where the patch should have applied. You can paste that snippet
> (from the **Nikas PDF Patcher** output) into an issue instead of sending the whole
> multi-megabyte bundle, and the next patch can be written precisely against it.

## Terminal / CLI (Claude Code with DeepSeek)

Nikas itself is an **IDE-only provider** (it registers a `LanguageModelChatProvider` inside VS Code's extension host, so the standalone Copilot CLI can't load it). To use DeepSeek V4 in a terminal agent, Claude Code can be pointed at DeepSeek's Anthropic-compatible endpoint. A ready-made setup script is included:

```powershell
# from the repo root — configures Claude Code for DeepSeek (key prompt first run)
.\claude-deepseek.ps1
claude
```

The script prompts for your DeepSeek API key once, then sets (per DeepSeek's official [agent-integration guide](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)):

| Variable | Value | Purpose |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://api.deepseek.com/anthropic` | DeepSeek's Anthropic-compatible endpoint |
| `ANTHROPIC_MODEL` / `OPUS` / `SONNET` | `deepseek-v4-pro[1m]` | Main model (1M window) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `deepseek-v4-flash` | Fast model tier |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `deepseek-v4-flash` | Fast subagents |
| `CLAUDE_CODE_EFFORT_LEVEL` | `max` | Deep reasoning |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `786432` | DeepSeek's official recommendation — matches the ~800K real-token quality limit measured for DeepSeek V4 on the 1M window |

The API key is stored in `%USERPROFILE%\.nikas-claude-key` (never in a committed file); remove it to be prompted again.

**Automatic mode:** the script also installs a `NIKAS_CLAUDE` block into your PowerShell `$PROFILE`, so DeepSeek's env vars load into **every new terminal** automatically — after the first key setup, `claude` just works. To undo: delete the `NIKAS_CLAUDE` block from `$PROFILE`, and delete `%USERPROFILE%\.nikas-claude-key` to forget the key.

## Commands

| Command | Description |
|---|---|
| `Nikas: Setup (First-Time Wizard)` | Guided setup — API key, vision provider, and model in one place |
| `Nikas: Choose Provider` | Select which DeepSeek model to use |
| `Nikas: Choose Vision Model` | Select which vision model preprocesses images (Gemma 4 or Gemini) |
| `Nikas: Set Ollama Host` | Configure Ollama server URL (supports remote instances) |
| `Nikas: Copilot PDF Patch Status` | Show whether the Copilot Chat PDF patches are applied |
| `Nikas: Re-apply Copilot PDF Patches` | Force re-apply the PDF patches to the installed Copilot Chat bundle |
| `Nikas: Check for Updates` | Download and install the latest Nikas release from GitHub |
| `Nikas: Usage & Cost` | Open the token/cost dashboard (total, this session, by provider, top sessions, copy markdown report) |
| `Nikas: Reset Usage Stats` | Clear all recorded usage (with confirmation) |
| `Nikas: Persistent Memory` | Inspect the session memory saved to `nikas.md` (survives restarts) |
| `Nikas: Run Agent` | Run a task through the built-in agent harness loop in the current workspace, streaming to an output channel |
| `Manage Nikas Models` | Manage API keys, model selection, vision provider, Ollama host, and PDF patches |

## Settings

| Setting | Default | Description |
|---|---|---|
| `nikas.selectedModel` | `deepseek-v4-flash` | Active chat model (`deepseek-v4-flash` or `deepseek-v4-pro`) |
| `nikas.visionModel` | `gemini` | Vision model for image preprocessing (`gemini`, `gemini-flash-lite`, or `ollama-gemma4`) |
| `nikas.ollamaBaseUrl` | `http://localhost:11434` | Ollama server URL (supports remote instances) |
| `nikas.maxTokens` | `16K` | Maximum output tokens per response |
| `nikas.temperature` | `0.7` | Response creativity (0–2) |
| `nikas.thinkingEffort` | `low` | Thinking/reasoning effort (`off`, `low`, `high`, `max`) — the fallback when the per-model "Thinking Effort" dropdown in Copilot Chat's model picker isn't set (the dropdown is present, matching upstream Nika). Low is the default (the recommended floor for tool-calling/agentic work; `off` matches upstream Nika's no-thinking behavior for max speed); max gives the best quality for complex builds but is slowest and most expensive. Per-agent overrides via `nikas.agentEfforts` |
| `nikas.contextWindow` | `950K` | Maximum input context window (32K–950K). 950K stays under the API's 1,048,576-token hard ceiling |
| `nikas.logLevel` | `INFO` | Logging verbosity (`OFF`, `ERROR`, `WARN`, `INFO`, `VERBOSE`) |
| `nikas.logMaxSizeMB` | `5` | Max size of `nikas.log` before it rotates (`nikas.log.1`, `.2`, ...). `0` disables rotation |
| `nikas.logMaxFiles` | `5` | How many rotated log files to keep before pruning the oldest. `0` truncates instead |
| `nikas.autoPatchCopilot` | `true` | Auto re-apply the Copilot Chat PDF patches after updates |
| `nikas.copilotMaxFileSizeMB` | `100` | Max attachment size (MB) Copilot Chat is patched to accept |
| `nikas.autoReloadAfterPatch` | `false` | Auto-reload the window after re-applying patches (vs. prompting) |
| `nikas.patchBackupRetention` | `5` | Number of Copilot bundle backups to keep |
| `nikas.updateRepo` | `alive2/nika` | GitHub repo used by `Nikas: Check for Updates` — **set to your own fork** |
| `nikas.autoCheckUpdates` | `false` | Periodically check for Nikas updates (silent when up-to-date) |
| `nikas.usageTracking` | `true` | Track per-conversation token usage + estimated cost (Usage & Cost dashboard + status bar). Disabling stops recording and hides the status bar item — never affects chat behavior |
| `nikas.memoryPersistence` | `true` | Persist session-memory summaries to a per-workspace `nikas.md` and re-inject them after a restart. Disabling stops saving and injecting — never affects chat behavior |
| `nikas.contextBudget` | `true` | Context-budget manager: live warnings near the window + reclaim tokens by dropping low-value tool output before discarding user context. Disabling turns both off |
| `nikas.contextWarnThreshold` | `70` | Context fill % at which the live budget warning fires |
| `nikas.contextCriticalThreshold` | `88` | Context fill % at which truncation is flagged as imminent |
| `nikas.agentCommand` | `true` | Expose the `Nikas: Run Agent` command (built-in agent harness). Disabling hides it — never affects chat |
| `nikas.modelRouter` | `false` | Route cheap internal helper requests (chat titles, git commit messages, etc.) to the faster Flash model even when Pro is selected. Never routes Responses-family model ids to `/chat/completions` |
| `nikas.modelRouterMode` | `helpers-only` | Router mode: `helpers-only` routes internal helpers to Flash; `auto` additionally routes heavy agent tasks (10+ tools) to Pro and quick chats (no tools) to Flash |
| `nikas.harnessPermissionGate` | `true` | Fail-closed permission gate for terminal commands run by the built-in agent harness. Never affects Copilot's own permission flow |
| `nikas.harnessToolCache` | `true` | Cache read-only tool results within a single harness run (identical calls execute once) |
| `nikas.visionStructured` | `true` | Use the structured image-extraction prompt (OCR, tables as markdown, layout — no invented content) |
| `nikas.maxImagesPerVisionCall` | `8` | Max images per vision-model call; larger sets are described in sequential batches and combined |
| `nikas.applyAgentModelsOnActivate` | `true` | On activation, apply recommended Copilot agent model assignments (Explore, Plan, Inline Chat → `nikas/deepseek-v4-flash-responses`) for agents the user hasn't configured. Never overrides an existing choice |

## How It Works

```
You send a message (text + optional image / PDF)
        │
        ▼
┌──────────────────────────────┐
│  Has images?                 │
│  YES → Vision model describes│
│        (Gemma 4 or Gemini)   │
│  NO  → skip                  │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────┐
│  DeepSeek API            │
│  api.deepseek.com        │
│  (your API key)          │
└──────────┬───────────────┘
           │
           ▼
    Streaming response
    in Copilot Chat
```

### PDF patch lifecycle

```
VS Code starts / Copilot Chat updates / 15-min timer
        │
        ▼
┌───────────────────────────────────────────┐
│  Locate Copilot Chat bundle               │
│  (resources/app/extensions/copilot/dist/) │
└──────────────┬────────────────────────────┘
               ▼
┌──────────────────────────────┐   all applied
│  Health check — markers +    │──────────────► nothing to do
│  applied-regexes + OUTCOME-  │
│  based verify()              │
└──────────────┬───────────────┘
               ▼  missing
┌──────────────────────────────┐
│  Backup bundle (.bak-*)      │
│  Apply each patch:           │
│    1. exact find/replace     │
│    2. regex fallback         │
│    3. ADAPTIVE (self-heal)   │
│  Write + re-verify           │
└──────────────┬───────────────┘
               ▼
   Notify "Re-applied N patches" → Reload Now
```

**Why this survives Copilot updates (v0.7.77+):** Copilot Chat minifies its bundle
and renames symbols on every update (`kkn`→`Fyn`, `RCt`→`Jht`, `VD`→`mB`, `v`→`_`,
`Lu`→`iu`, …). The patch engine therefore has three layers:

1. **Exact find/replace** — fastest path when the anchor text is unchanged.
2. **Regex fallback** — tolerates renamed minified identifiers by capturing them
   (e.g. matches the 3-predicate allowlist shape whatever its name).
3. **Adaptive (self-healing)** — locates the target region via *stable content
   anchors* (error strings like `"does not support PDF documents."`, property
   names like `chatVariables.filter`, and API constants like `1024*1024*`), then
   **extracts the real minified names from the bundle at apply time** and rebuilds
   the exact edit using only those names. It never depends on a symbol that can
   drift.

Patches are also detected by **outcome** (`verify()`) — e.g. P8 is "applied" when
the forwarded chat-variables filter ORs in the binary check, whatever the
predicate names are — so a bundle is never falsely reported broken. A runtime
**alias-safety net** refuses any injection that would reference a module
identifier the bundle never had, so a drifted bundle can never be corrupted —
worst case it reports "needs manual review" instead of crashing.

**Regression tests:** `test-patch-drift.js` simulates multiple Copilot bundle
generations with different minified names (including an "extreme-drift" bundle
that forces the adaptive tier) and asserts the engine self-heals every one.
`test-patch-real-drift.js` takes the actual installed bundle, reverts the five
drift-prone patches to their unpatched forms, and proves the engine re-applies
them with valid syntax. Run both after any patch-definition change:
`node test-patch-drift.js` and `node test-patch-real-drift.js <bundle>`.

## Requirements

- VS Code 1.109+
- DeepSeek API key ([get one here](https://platform.deepseek.com/))
- For vision: [Ollama](https://ollama.com) with `gemma4:31b` (default, local) OR Gemini API key ([free tier](https://aistudio.google.com/apikey))
- For the PDF auto-patcher: write access to your VS Code install folder (`AppData\Local\Programs\Microsoft VS Code\...`) — the default per-user install is writable

## Development

```bash
git clone https://github.com/alive2/nika.git
cd nika
npm install
npm run compile
```

To package:

```bash
npm run package
```

## Publishing your own Nikas

To ship this as your own extension:

1. Create your own GitHub repo and push this code (or a fork).
2. Update `nikas.updateRepo` to your `owner/repo`.
3. Create a release with a `nikas-<version>.vsix` asset (`npm run package`).
4. Optionally set `nikas.autoCheckUpdates` to `true`.

## License

MIT

