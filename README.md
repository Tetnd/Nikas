# Nika

**DeepSeek language model provider for VS Code Copilot Chat**, with Gemini-powered vision preprocessing.

Adds DeepSeek V4 models to Copilot Chat's model picker. Bring your own API key — no GitHub Copilot subscription required.

## Features

- **DeepSeek V4 Flash & Pro** — fast and powerful models in the Copilot Chat model picker
- **Gemini-powered vision** — send images in chat and they're automatically described by Gemini 2.5 Flash (free tier), then forwarded to DeepSeek
- **Streaming responses** — real-time token-by-token output
- **Tool calling** — full support for VS Code's built-in tools (read files, run terminal commands, search, etc.)
- **Secure key storage** — API keys stored in your OS keychain, never in plaintext settings

## Quick Start

### 1. Install

```bash
code --install-extension nika-0.1.0.vsix
```

Or download from [Releases](https://github.com/alive2/nika/releases).

### 2. Configure

You need two API keys:

| Key | Where to get it | Purpose |
|---|---|---|
| DeepSeek API key | [platform.deepseek.com](https://platform.deepseek.com/) | Chat responses |
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (free) | Vision/image preprocessing |

Store the DeepSeek key:

```jsonc
// In VS Code settings.json
"nika.deepseekApiKey": "sk-..."
```

Set the Gemini key via the command palette:

1. `F1` → `Manage Nika Models` → `Input Gemini API Key`
2. Paste your Gemini API key (`AIza...`)

### 3. Select a model

1. Open Copilot Chat (`Ctrl+Shift+I`)
2. Click the model picker dropdown at the top
3. Select **DeepSeek V4 Flash** or **DeepSeek V4 Pro**
4. Start chatting

### 4. Enable vision (optional)

To send images to DeepSeek:

1. `F1` → `Manage Nika Models` → `Input Gemini API Key`
2. Get a free key at [Google AI Studio](https://aistudio.google.com/apikey)
3. Paste it in — images are now automatically described before reaching DeepSeek

## Commands

| Command | Description |
|---|---|
| `Nika: Choose Provider` | Select which DeepSeek model to use |
| `Manage Nika Models` | Manage API keys and model selection |

## Settings

| Setting | Default | Description |
|---|---|---|
| `nika.selectedModel` | `deepseek-v4-flash` | Active model (`deepseek-v4-flash` or `deepseek-v4-pro`) |
| `nika.maxTokens` | `8192` | Maximum output tokens per response |
| `nika.temperature` | `0.7` | Response creativity (0–2) |

## How It Works

```
You send a message (text + optional image)
        │
        ▼
┌──────────────────────────┐
│  Has images?             │
│  YES → Gemini describes  │
│  NO  → skip              │
└──────────┬───────────────┘
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
- Gemini API key for vision ([free tier](https://aistudio.google.com/apikey))

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
