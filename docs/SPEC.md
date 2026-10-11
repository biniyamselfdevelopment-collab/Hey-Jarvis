# Hey Jarvis — Design Spec

> A friendly helper that lives inside your computer. Say **"Hey Jarvis"**, ask for
> anything, and it actually does it: searches the web, drives apps, prompts Claude
> Code, posts to your socials, handles email and calendar, and points at things on
> your screen.

Status: **v0 spec + scaffold** · Owner: personal project · Last updated: 2026-10-11

---

## 1. Decisions so far (from the kickoff Q&A)

| Topic | Decision |
|---|---|
| Platforms | **Cross-platform from day one**: Windows, macOS, Linux. Primary dev machine is a PC with an RTX 3070 (8 GB), so **Windows gets polished first**. |
| Stack | **Tauri 2** (Rust shell + React/TypeScript UI) plus a **TypeScript agent core** that runs as a sidecar process. |
| Models | **Whatever the user prefers.** OpenCode server, local coding-agent CLIs (the Open Design approach), or bring your own key (BYOK) for any OpenAI-compatible, Anthropic or Ollama endpoint. |
| Web search | **Built in.** Works with no API key; Brave, Tavily or Exa are optional upgrades. |
| Activation | **"Hey Jarvis" wake word** detected on-device. Typed input is available as a fallback. |
| Speech-to-text | **Local Whisper** (whisper.cpp on CUDA). |
| Voice output | **Local TTS**: Kokoro by default, Piper as a fallback. |
| Screen | **See, point and act**, like Hey Clicky: screenshots, an on-screen pointer, clicking and typing. |
| Safety | **Risky actions need a confirmation, and you can give it by voice** ("yes, go ahead" / "no, cancel"). |
| Coding agents | **Claude Agent SDK** for Claude Code. OpenCode sessions are a second delegate. |
| Social | **Every platform you connect.** Official APIs where they're usable, with **browser automation as the fallback**. |
| Skills | Anything on the PC: web and research, apps, files and system, email, calendar and messages, memory and routines. |
| Extensibility | Tell it in plain language what to do, **MCP servers**, **skills** (markdown playbooks), **tools Jarvis writes itself**, and later a **plugin marketplace**. |
| UI | **Top-center pill** in the style of Dynamic Island. On notched Macs it sits flush in the notch. |
| Personality | **A friendly helper inside the computer.** Warm, concise and upbeat. Not a butler. |
| Audience | **Personal for now.** |
| Data | **Local first.** SQLite plus the OS keychain, with **optional cloud sync** later. |
| VRAM budget | **≤ 2 GB by default**, leaving the rest of the 3070 for games and other work. |

---

## 2. Architecture

```
┌───────────────────────────── Tauri app (Rust) ──────────────────────────────┐
│                                                                             │
│  Pill window (React)       Voice engine                  OS bridge          │
│  ┌──────────────┐          ┌──────────────────────┐      ┌───────────────┐  │
│  │ idle/listen/ │◀─events──│ mic (cpal, 16 kHz)   │      │ screenshots   │  │
│  │ think/speak/ │          │  └▶ wake word (ONNX) │      │ (xcap)        │  │
│  │ confirm      │──cmds───▶│  └▶ VAD → Whisper    │      │ mouse/keys    │  │
│  └──────────────┘          │ TTS (Kokoro ONNX)───▶│spk   │ (enigo)       │  │
│                            └─────────┬────────────┘      │ a11y tree     │  │
│                                      │ text              │ keychain      │  │
│                    JSON lines over stdio                 └──────▲────────┘  │
└──────────────────────────────────────┼──────────────────────────┼───────────┘
                                       ▼                          │ host tools
┌──────────────────────── Agent core (TypeScript sidecar) ───────────────────┐
│  Brain router ── native loop (AI SDK) ── tool registry ── permission gate  │
│      │                                     │                    │          │
│      ├─ OpenCode server (localhost:4096)   ├─ web search/fetch  └─ voice/UI│
│      ├─ agent CLIs: claude, codex, …       ├─ apps/files/shell     confirm │
│      └─ BYOK: OpenAI-compat, Anthropic,    ├─ Claude Code (Agent SDK)      │
│               Ollama, OpenCode Zen         ├─ social / email / calendar    │
│                                            ├─ MCP client (any server)      │
│  Memory (SQLite) · Skills · Routines       └─ screen tools (via host)      │
└────────────────────────────────────────────────────────────────────────────┘
```

### Why it's split this way
- **Rust owns anything that is real-time or touches the OS**: audio, wake word, Whisper, TTS, screen capture, input injection and the keychain. These need low latency and native APIs, and Rust has good cross-platform crates for all of them.
- **TypeScript owns the brain.** The AI SDK, the Claude Agent SDK, the OpenCode SDK and the MCP SDK are all strongest in TS, and iterating on agent logic in TS is fast.
- The core speaks a small **JSON-lines protocol** over stdio (`packages/core/src/protocol.ts`), so it can be run, tested and debugged headless without the desktop app.
- For release, the core is compiled into a single binary with `bun build --compile` and shipped as a Tauri sidecar.

---

## 3. The brain: how Jarvis connects to models

Jarvis copies **Open Design's** approach. It detects what you already have and lets you choose, and it never forces a particular vendor.

1. **OpenCode server.** If `opencode serve` is running (default `http://localhost:4096`), Jarvis can hand work to OpenCode sessions. Every provider and model you've set up in OpenCode becomes available.
2. **Local agent CLIs.** Jarvis scans your `PATH` for `claude`, `codex`, `opencode`, `gemini` and similar tools, the same way Open Design does. Claude Code is driven through the **Claude Agent SDK**.
3. **BYOK endpoints** for Jarvis's own fast loop:
   - OpenAI-compatible: OpenAI, OpenRouter, **OpenCode Zen**, Groq, LM Studio and others
   - Anthropic
   - **Ollama** (fully local; works on the 3070 with a small model)

### Two layers
- **Native loop (the default).** Jarvis's own tool-calling loop, built on the AI SDK and pointed at a fast model. It handles about 90% of requests: quick answers, web lookups, opening apps, confirmations. The latency goal is about 1.5 s from the end of speech to the first spoken word.
- **Delegates.** For heavy, multi-step work (coding, long research), the native loop calls a *delegate tool* such as `claude_code` or `opencode_session`. Jarvis narrates progress ("Claude's running the tests now…") and summarises the result out loud.
- **Fallback.** With no BYOK model set up, the router runs the whole turn through a delegate instead. Jarvis's own tools are exposed to it as a local **`jarvis` MCP server**, so it can still click, search and post.

---

## 4. Voice pipeline

| Stage | Choice | Notes |
|---|---|---|
| Capture | `cpal` at 16 kHz mono | Device selectable in settings |
| Wake word | **openWakeWord**, pretrained `hey_jarvis` model, run in ONNX Runtime (`ort`) | CPU, about 1–2% of one core |
| End of speech | Silero VAD (ONNX) | Ends the utterance after about 700 ms of silence |
| STT | **whisper.cpp** via `whisper-rs` with the `cuda` feature | `small.en` (about 1 GB VRAM) by default; `medium` is optional |
| TTS | **Kokoro-82M** (ONNX) | CPU or GPU; streams sentence by sentence. Piper is the fallback. |
| Barge-in | If the wake word fires while Jarvis is speaking, TTS stops | |
| Follow-up | After Jarvis speaks, the mic stays open for about 6 s with no wake word | This is what makes voice confirmations natural |

**Voice confirmation flow.** When the agent calls a risky tool, the core sends `confirm_request`. Jarvis says something like *"I'm about to post this to X and LinkedIn: '…'. Should I go ahead?"* and the pill shows Approve / Cancel. The next utterance goes through `parseConfirmation()`: "yes / go ahead / do it / send it" approves, and "no / cancel / wait / stop" denies. If the answer is unclear, Jarvis asks once more, then cancels.

---

## 5. Tools and permissions

Every tool declares a **risk level**:

| Risk | Behaviour | Examples |
|---|---|---|
| `low` | Runs immediately | web search, read a page, read the calendar, take a screenshot |
| `medium` | Runs, and Jarvis says what it did | open an app or URL, create a draft, set volume |
| `high` | **Needs confirmation** (voice or click) | post publicly, send email or messages, run shell commands, click or type on screen, delete files, buy anything, change system settings |

You can override each tool in settings with `allow` / `ask` / `deny`. Every action is written to an audit log in the `history` table and can be replayed.

### Tool catalogue (by milestone)
- **Web**: `web_search` (DuckDuckGo with no key; Brave/Tavily/Exa with a key), `fetch_page` (readable text), `research` (search → read N pages → cited summary)
- **System**: `open_app`, `open_url`, `run_shell`, `find_files`, `read_file`, `write_file`, `clipboard`, `volume`, `brightness`, `window_manage`, `media_control`
- **Coding**: `claude_code` (Agent SDK, streams progress), `opencode_session`, `craft_prompt` (turns a rambling voice note into a strong prompt)
- **Screen** (host tools in Rust): `screenshot`, `point_at` (draws the overlay cursor), `click`, `type_text`, `press_keys`, `read_ui` (UIAutomation on Windows, AX on macOS, AT-SPI on Linux)
- **Social**: `post` (fans out to every connected account), `draft_post`, `schedule_post`
  - Official APIs: LinkedIn, Bluesky, Mastodon, Threads, Instagram and Facebook (Meta Graph), YouTube, Reddit
  - Browser fallback: Playwright with a **persistent, logged-in profile**, for X and anything else without a usable API
- **Comms**: Gmail / Outlook (read, draft, send), Google / Microsoft Calendar, Slack, Discord
- **Memory**: `remember`, `recall`, `forget`; routines ("morning briefing", "work mode")
- **Extensibility**: MCP client (any stdio/HTTP server), a skills loader for `skills/*.md`, and `build_tool` (asks Claude Code to write a new MCP server and then registers it)

---

## 6. UI: the pill

- A transparent, frameless, always-on-top window at **top-center** of the active monitor. It's click-through when idle, except over the pill itself.
- On notched MacBooks it sits flush in the notch. Everywhere else it's a black pill about 180×36 px.
- States: `idle` (tiny dot) → `listening` (live waveform) → `thinking` (shimmer) → `speaking` (waveform plus captions) → `confirm` (expands with action details and Approve / Cancel) → `working` (progress for long delegate tasks; click to expand).
- From the tray icon: settings, connected accounts, models, tool permissions, history, quit.
- Typed input: press a hotkey (`Ctrl+Space` by default) or click the pill.

---

## 7. Data and storage

- **Local SQLite** (`~/.hey-jarvis/jarvis.db`): `memory`, `history` (the audit log), `routines`, `settings`.
- **Secrets** (API keys, OAuth tokens) go in the **OS keychain** through the `keyring` crate and never in SQLite.
- **Optional cloud sync** (a later milestone): Supabase stores end-to-end-encrypted memory, settings and routines. Secrets are never synced.

---

## 8. Milestones

| # | Milestone | What "done" looks like |
|---|---|---|
| **M0** | Spec + scaffold *(this commit)* | Monorepo builds, the core runs headless over stdio, the pill renders its states, tests pass |
| **M1** | **Voice loop** | "Hey Jarvis, what's the weather in Addis?" → wake → Whisper → native loop + web search → Kokoro speaks, in under 2 s on the 3070 |
| **M2** | Core tools | Apps, files, shell and Claude Code via the Agent SDK, with voice confirmation working end to end |
| **M3** | Screen | Screenshot + vision model, pointer overlay, click and type with confirmation, accessibility-tree reading |
| **M4** | Accounts | OAuth connections, email, calendar, Slack, social posting (APIs plus the browser fallback) |
| **M5** | Memory and extensibility | SQLite memory, routines, MCP client, skills, `build_tool` |
| **M6** | Polish and sync | macOS notch mode, cloud sync, plugin marketplace, installers and auto-update |

---

## 9. Risks and open questions

- **Rust ONNX voice stack.** openWakeWord's pipeline (melspectrogram → embedding → `hey_jarvis` head) has to be reimplemented around `ort`. *Fallback:* a small Python voice sidecar (`openwakeword`, `faster-whisper`, `kokoro-onnx`) that speaks the same protocol.
- **CUDA builds of whisper-rs on Windows** need the CUDA toolkit installed. A CPU build or Vulkan is the fallback.
- **X/Twitter posting.** The API is paid, so it goes through the browser fallback, which may break when their UI changes and is against their terms of service. Use it with care.
- **Screen control on Wayland.** Input injection and screenshots are restricted. It needs portals or ydotool, and is best effort.
- **Prompt injection.** Content from web pages or emails could try to make Jarvis act. Mitigations: risky tools always need confirmation, and tool output is always treated as data, never as instructions.
- **To decide later:** default model for the native loop (the user picks one at first run), cloud sync provider, marketplace format.
