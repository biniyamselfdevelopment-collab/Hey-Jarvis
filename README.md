# Hey Jarvis

A friendly helper that lives at the top of your screen and **actually does things**.
Say **"Hey Jarvis"** and ask: it thinks with **OpenCode**, searches the web, opens apps and sites, runs
commands, and hands big coding jobs to Claude Code. Risky actions always ask first, and you can just say
*"yes, go ahead"*. Everything you say stays on your PC: the wake word, speech recognition (Whisper) and
Jarvis's voice (Kokoro) all run locally.

> **Status: M1, the voice loop, is built.** See [`docs/SPEC.md`](docs/SPEC.md) for the design and roadmap.

## Quick start (Windows)

You need **Node 22+, pnpm, Rust, uv, git and OpenCode**. The setup script checks for all of them and tells you how to install anything that's missing.

```powershell
git clone https://github.com/biniyamselfdevelopment-collab/Hey-Jarvis
cd Hey-Jarvis
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
pnpm dev        # starts Jarvis
```

`setup` installs dependencies, the Python voice engine (with CUDA libraries for your NVIDIA GPU), and about 1 GB of voice models.
Make sure OpenCode works first: run `opencode` once, sign in, and pick a model.

### Talking to Jarvis
| Do this | What happens |
|---|---|
| Say **"Hey Jarvis, …"** | The wake word fires and Jarvis listens until you pause |
| **Ctrl+Shift+J** | Listen without the wake word |
| **Ctrl+Shift+K**, or click the pill | Type instead |
| Say "Hey Jarvis" while it talks | It stops talking and listens |
| When it asks "Should I go ahead?" | Say **yes** or **no**, or click |
| **Esc** | Cancel what it's doing |

## Configuration: `~/.hey-jarvis/config.json`

Every field is optional. The comments below are only explanations, and the real file must be plain JSON.

```jsonc
{
  "brain": "opencode",                       // "opencode" | "native" | "auto"
  "opencode": {
    "model": "anthropic/claude-haiku-5-5"    // optional: a FAST model makes voice snappier
  },
  "voice": {
    "voice": "af_heart",                     // Kokoro voice (American English). Try am_michael, af_bella…
    "whisperModel": "small.en",              // tiny.en | base.en | small.en | medium.en
    "device": "auto",                        // auto | cuda | cpu
    "followUpMs": 0                          // > 0 keeps the mic open after every answer
  },
  "toolPolicies": { "bash": "ask", "open_app": "allow" }   // allow | ask | deny, per tool
}
```

## How it fits together

| Piece | Tech | Path |
|---|---|---|
| Desktop shell: pill window, tray, hotkeys, message router | Tauri 2 (Rust) | `apps/desktop/src-tauri` |
| Pill UI | React + Vite | `apps/desktop/src` |
| Brain: OpenCode/native brains, Jarvis tools, MCP server, voice confirmations | TypeScript | `packages/core` |
| Voice: wake word, VAD, Whisper, Kokoro | Python (uv) | `apps/voice` |

The pieces talk over JSON lines on stdio. Jarvis starts a **private OpenCode server**, adds a `jarvis` agent to it,
and exposes its own tools to OpenCode through a local MCP server. When OpenCode wants to run a command or edit a
file, the request is routed to Jarvis's yes/no voice confirmation.

## Development

```bash
pnpm test           # core: unit tests + integration tests against the real OpenCode binary (when it's on PATH)
pnpm test:voice     # voice: engine tests + real-model tests (wake word / VAD on Kokoro-synthesised speech)
pnpm typecheck
cd apps/desktop/src-tauri && cargo test && cargo clippy

pnpm core           # run the agent core headless; type JSON lines like
                    # {"type":"utterance","id":"1","text":"hello","source":"typed"}
pnpm voice          # run the voice engine on its own
pnpm --filter @hey-jarvis/desktop vite   # design the pill in a browser (plays a demo loop)
```
