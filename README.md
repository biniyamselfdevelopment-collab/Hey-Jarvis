# Hey Jarvis

A friendly helper that lives in your screen's notch (or a top-center pill) and **actually does things**.
Say **"Hey Jarvis"**, ask for anything, and it searches the web, opens apps, prompts Claude Code, posts to your
socials, handles email and calendar, and points at things on your screen. Risky actions always ask first, and
you can answer out loud: *"yes, go ahead"*.

> **Status: M0, the spec and scaffold.** The agent core runs headless with web, system and Claude Code tools and
> voice-style confirmations. The pill UI renders all of its states. The voice pipeline (wake word, Whisper, Kokoro) is next (M1).
> Full design: [`docs/SPEC.md`](docs/SPEC.md).

## How it fits together

| Piece | Tech | Path |
|---|---|---|
| Desktop shell, pill window, tray, voice and screen (planned) | Tauri 2 (Rust) | `apps/desktop/src-tauri` |
| Pill UI | React + Vite | `apps/desktop/src` |
| Agent brain: model routing, tools, permissions | TypeScript + AI SDK | `packages/core` |

The two halves talk over a small JSON-lines protocol on stdio (`packages/core/src/protocol.ts`).

### Models: bring whatever you already have
Like [Open Design](https://github.com/nexu-io/open-design), Jarvis detects what's on your machine:
- a running **OpenCode server** (`opencode serve`)
- **coding-agent CLIs** on your PATH (Claude Code, Codex, OpenCode, Gemini, …)
- any **BYOK** endpoint: OpenAI-compatible (OpenAI, OpenRouter, OpenCode Zen, Groq, LM Studio), Anthropic, or **Ollama** for fully local

## Quick start

```bash
pnpm install

# Configure a model for the fast native loop (example: local Ollama)
mkdir -p ~/.hey-jarvis
echo '{ "provider": { "preset": "ollama", "model": "qwen3:8b" } }' > ~/.hey-jarvis/config.json

# Talk to the core headless
echo '{"type":"utterance","id":"1","text":"search the web for tauri 2 news","source":"typed"}' | pnpm core

# Run the desktop app (needs the Tauri prerequisites: https://tauri.app/start/prerequisites/)
pnpm dev

# Design the pill in a plain browser (plays a demo loop of every state)
pnpm --filter @hey-jarvis/desktop vite
```

Other providers:
```jsonc
{ "provider": { "preset": "opencode-zen", "model": "<model>", "apiKeyEnv": "OPENCODE_API_KEY" } }
{ "provider": { "preset": "anthropic", "model": "claude-haiku-5-5", "apiKeyEnv": "ANTHROPIC_API_KEY" } }
{ "provider": { "preset": "custom", "baseURL": "http://localhost:8080/v1", "model": "my-model" } }
```

Per-tool permissions (`allow` / `ask` / `deny`) override the risk defaults:
```json
{ "toolPolicies": { "run_shell": "deny", "open_app": "ask" } }
```

## Development

```bash
pnpm test        # core unit tests (permissions, voice confirmations, search parsing, agent loop)
pnpm typecheck
cd apps/desktop/src-tauri && cargo check && cargo test
```
