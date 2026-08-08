# Nikas

**DeepSeek language model provider for VS Code Copilot Chat**, with configurable vision preprocessing (Gemma 4 via Ollama or Gemini) **and automatic restoration of PDF support in Copilot Chat**.

Nikas is a fork of the [Nika](https://github.com/alive2/nika) extension. It adds DeepSeek V4 models to Copilot Chat's model picker (bring your own API key — no GitHub Copilot subscription required) and — unlike stock Copilot Chat — keeps **PDF attachments working for third-party providers** by automatically re-applying the Copilot Chat PDF patches whenever an update wipes them.

## Features

- **DeepSeek V4 Flash & Pro** — fast and powerful models in the Copilot Chat model picker
- **DeepSeek V4 Flash (Responses)** — the same Flash 0731 model served through DeepSeek's newer Responses API (`POST /responses`), built for agent-native tooling
- **📄 PDF support that survives updates** — Copilot Chat drops PDF attachments for third-party providers. Nikas patches the installed Copilot Chat bundle (8 surgical patches: allow DeepSeek to receive PDFs, raise the 5 MB read limit to 100 MB, let PDFs bypass `omitContents`, drop the `supportsVision` gate, convert `Document` parts to `LanguageModelDataPart`, etc.) and **re-applies them automatically** after every Copilot Chat / VS Code update
- **Vision preprocessing** — send images in chat and they're automatically described by Gemma 4 (local, via Ollama) or Gemini 2.5 Flash (free tier), then forwarded to DeepSeek
- **Streaming responses** — real-time token-by-token output
- **Tool calling** — full support for VS Code's built-in tools (read files, run terminal commands, search, etc.)
- **Secure key storage** — API keys stored in your OS keychain, never in plaintext settings
- **Local-first vision** — Gemma 4 runs on your own machine via Ollama, no cloud API key needed

## Quick Start

### 1. Install

```bash
code --install-extension nikas-0.7.0.vsix
```

### 2. Configure

You need a DeepSeek API key. For vision/image support, choose one vision provider:

| Key / Setup | Where to get it | Purpose |
|---|---|---|
| DeepSeek API key | [platform.deepseek.com](https://platform.deepseek.com/) | Chat responses |
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

### 3. Select a chat model

1. Open Copilot Chat (`Ctrl+Shift+I`)
2. Click the model picker dropdown at the top
3. Select **DeepSeek V4 Flash**, **DeepSeek V4 Pro**, or **DeepSeek V4 Flash (Responses)**
4. Start chatting

> **DeepSeek V4 Flash (Responses)** uses DeepSeek's newer Responses API (`POST /responses`) instead of Chat Completions. It's selected via the Copilot model picker only (it's not part of `Nikas: Choose Provider`).

### 4. PDF support

Attach a PDF in chat and send it — it should reach DeepSeek as a document part. If a Copilot Chat / VS Code update wiped the patches, Nikas re-applies them automatically (you'll get a notification with a **Reload Now** button). To inspect or force it:

- `F1` → `Nikas: Copilot PDF Patch Status` — shows which of the 8 patches are applied
- `F1` → `Nikas: Re-apply Copilot PDF Patches` — forces a patch cycle now

The patcher writes the bundle to `...\resources\app\extensions\copilot\dist\extension.js` and keeps timestamped `.bak-*` backups (pruned after `nikas.patchBackupRetention`). All activity is logged to the **Nikas PDF Patcher** output channel and `nikas.log`.

## Commands

| Command | Description |
|---|---|
| `Nikas: Choose Provider` | Select which DeepSeek model to use |
| `Nikas: Choose Vision Model` | Select which vision model preprocesses images (Gemma 4 or Gemini) |
| `Nikas: Set Ollama Host` | Configure Ollama server URL (supports remote instances) |
| `Nikas: Copilot PDF Patch Status` | Show whether the Copilot Chat PDF patches are applied |
| `Nikas: Re-apply Copilot PDF Patches` | Force re-apply the PDF patches to the installed Copilot Chat bundle |
| `Nikas: Check for Updates` | Download and install the latest Nikas release from GitHub |
| `Manage Nikas Models` | Manage API keys, model selection, vision provider, Ollama host, and PDF patches |

## Settings

| Setting | Default | Description |
|---|---|---|
| `nikas.selectedModel` | `deepseek-v4-flash` | Active chat model (`deepseek-v4-flash` or `deepseek-v4-pro`) |
| `nikas.visionModel` | `ollama-gemma4` | Vision model for image preprocessing (`ollama-gemma4` or `gemini`) |
| `nikas.ollamaBaseUrl` | `http://localhost:11434` | Ollama server URL (supports remote instances) |
| `nikas.maxTokens` | `8K` | Maximum output tokens per response |
| `nikas.temperature` | `0.7` | Response creativity (0–2) |
| `nikas.autoPatchCopilot` | `true` | Auto re-apply the Copilot Chat PDF patches after updates |
| `nikas.copilotMaxFileSizeMB` | `100` | Max attachment size (MB) Copilot Chat is patched to accept |
| `nikas.autoReloadAfterPatch` | `false` | Auto-reload the window after re-applying patches (vs. prompting) |
| `nikas.patchBackupRetention` | `5` | Number of Copilot bundle backups to keep |
| `nikas.updateRepo` | `alive2/nika` | GitHub repo used by `Nikas: Check for Updates` — **set to your own fork** |
| `nikas.autoCheckUpdates` | `false` | Periodically check for Nikas updates (silent when up-to-date) |

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
┌──────────────────────────────┐   unchanged
│  Health check (8 markers)    │──────────────► nothing to do
└──────────────┬───────────────┘
               ▼  missing
┌──────────────────────────────┐
│  Backup bundle (.bak-*)      │
│  Apply missing patches       │
│  Write + verify              │
└──────────────┬───────────────┘
               ▼
   Notify "Re-applied N patches" → Reload Now
```

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

