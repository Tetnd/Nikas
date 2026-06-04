# Nika

**DeepSeek language model provider for VS Code Copilot Chat**, with configurable vision preprocessing (Gemma 4 via Ollama or Gemini).

Adds DeepSeek V4 models to Copilot Chat's model picker. Bring your own API key — no GitHub Copilot subscription required.

## Features

- **DeepSeek V4 Flash & Pro** — fast and powerful models in the Copilot Chat model picker
- **Vision preprocessing** — send images in chat and they're automatically described by Gemma 4 (local, via Ollama) or Gemini 2.5 Flash (free tier), then forwarded to DeepSeek
- **Streaming responses** — real-time token-by-token output
- **Tool calling** — full support for VS Code's built-in tools (read files, run terminal commands, search, etc.)
- **Secure key storage** — API keys stored in your OS keychain, never in plaintext settings
- **Local-first vision** — Gemma 4 runs on your own machine via Ollama, no cloud API key needed

## Quick Start

### 1. Install

```bash
code --install-extension nika-0.2.0.vsix
```

Or download from [Releases](https://github.com/alive2/nika/releases).

### 2. Configure

You need a DeepSeek API key. For vision/image support, choose one vision provider:

| Key / Setup | Where to get it | Purpose |
|---|---|---|
| DeepSeek API key | [platform.deepseek.com](https://platform.deepseek.com/) | Chat responses |
| Gemma 4 via Ollama | `ollama pull gemma4:31b` | Vision preprocessing (local, default) |
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (free) | Vision preprocessing (cloud, alternative) |

Store the DeepSeek key:

```jsonc
// In VS Code settings.json
"nika.deepseekApiKey": "sk-..."
```

#### Set up Gemma 4 (default)

Install Ollama and pull the model — no API key needed:

```bash
# Install Ollama from https://ollama.com, then:
ollama pull gemma4:31b
```

Nika connects to Ollama at `http://localhost:11434` by default. To use a remote Ollama instance:

- `F1` → `Manage Nika Models` → `Set Ollama Host`, or
- `F1` → `Nika: Set Ollama Host`

Enter the remote URL (e.g., `http://192.168.1.100:11434`).

#### Set up Gemini (alternative)

Only needed if you switch vision models to Gemini:

1. `F1` → `Manage Nika Models` → `Input Gemini API Key`
2. Paste your Gemini API key (`AIza...`)
3. `F1` → `Manage Nika Models` → `Choose Vision Model` → pick **Gemini 2.5 Flash**

### 3. Select a chat model

1. Open Copilot Chat (`Ctrl+Shift+I`)
2. Click the model picker dropdown at the top
3. Select **DeepSeek V4 Flash** or **DeepSeek V4 Pro**
4. Start chatting

### 4. Switch vision model

1. `F1` → `Manage Nika Models` → `Choose Vision Model`
2. Pick **Gemma 4 (Ollama)** (local, default) or **Gemini 2.5 Flash** (cloud, needs key)
3. Images are now automatically described before reaching DeepSeek

## Commands

| Command | Description |
|---|---|
| `Nika: Choose Provider` | Select which DeepSeek model to use |
| `Nika: Choose Vision Model` | Select which vision model preprocesses images (Gemma 4 or Gemini) |
| `Nika: Set Ollama Host` | Configure Ollama server URL (supports remote instances) |
| `Manage Nika Models` | Manage API keys, model selection, vision provider, and Ollama host |

## Settings

| Setting | Default | Description |
|---|---|---|
| `nika.selectedModel` | `deepseek-v4-flash` | Active chat model (`deepseek-v4-flash` or `deepseek-v4-pro`) |
| `nika.visionModel` | `ollama-gemma4` | Vision model for image preprocessing (`ollama-gemma4` or `gemini`) |
| `nika.ollamaBaseUrl` | `http://localhost:11434` | Ollama server URL (supports remote instances, e.g. `http://192.168.1.100:11434`) |
| `nika.maxTokens` | `8192` | Maximum output tokens per response |
| `nika.temperature` | `0.7` | Response creativity (0–2) |

## How It Works

```
You send a message (text + optional image)
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

## Requirements

- VS Code 1.109+
- DeepSeek API key ([get one here](https://platform.deepseek.com/))
- For vision: [Ollama](https://ollama.com) with `gemma4:31b` (default, local) OR Gemini API key ([free tier](https://aistudio.google.com/apikey))

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

## License

MIT
