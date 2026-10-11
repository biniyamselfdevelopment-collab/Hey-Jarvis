# Hey Jarvis — Design Spec

> A friendly helper that lives inside your computer. Say **"Hey Jarvis"**, ask for
> anything, and it actually does it: searches the web, drives apps, prompts Claude
> Code, posts to your socials, handles email and calendar, and points at things on
> your screen.

Status: **M1 (voice loop) built** · Owner: personal project · Last updated: 2026-10-11

---

## 1. Decisions so far (from the kickoff Q&A)

| Topic | Decision |
|---|---|
| Platforms | **Cross-platform from day one**: Windows, macOS, Linux. Primary dev machine is a PC with an RTX 3070 (8 GB), so **Windows gets polished first**. |
| Stack | **Tauri 2** (Rust shell + React/TypeScript UI), a **TypeScript agent core** sidecar, and a **Python voice sidecar** run through `uv`. |
| Models | **OpenCode is the default brain**: the user's PC can't run good local models, OpenCode is fast and codes well, and it's already installed. BYOK through the native loop is still supported. |
| Web search | **Built in.** Works with no API key; Brave, Tavily or Exa are optional upgrades. |
| Activation | **"Hey Jarvis" wake word** detected on-device. Typed input is available as a fallback. |
| Speech-to-text | **Local Whisper** (whisper.cpp on CUDA). |
| Voice output | **Local TTS with Kokoro**, voice `af_heart` (American English) by default. |
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
┌────────────────────────────── Tauri app (Rust) ───────────────────────────────┐
│  Pill window (React)  ◀── events ──  Router (pure, unit-tested)  ── hotkeys    │
│  top-center, click-through          merges core + voice state     tray         │
│                                      │                  │                       │
│                       JSON lines/stdio                  JSON lines/stdio        │
└──────────────────────────────────────┼──────────────────┼──────────────────────┘
                                       ▼                  ▼
┌──────────── Agent core (TypeScript) ───────────┐   ┌──── Voice (Python, uv) ────┐
│ Jarvis: turns, permission gate (voice "yes")   │   │ mic 16 kHz → "Hey Jarvis"  │
│  ├─ OpencodeBrain ──▶ private `opencode serve` │   │ (openWakeWord ONNX) → VAD  │
│  │     "jarvis" agent + persona injected        │   │ (Silero) → Whisper (CUDA)  │
│  │     permission.asked ─▶ voice gate           │   │ Kokoro TTS, sentence queue │
│  │     MCP ◀─┐                                  │   │ barge-in, reply window     │
│  └─ NativeBrain (AI SDK, BYOK)                  │   └────────────────────────────┘
│  Jarvis MCP server (127.0.0.1, bearer token) ───┘
│   web_search · open_app · open_url · claude_code …
└────────────────────────────────────────────────┘
```

### Why it's split this way
- **The Rust host is a thin hub.** It owns the window, tray, hotkeys and click-through, and routes messages. Routing is a pure state machine (`router.rs`) with unit tests.
- **TypeScript owns the brain.** The OpenCode SDK, the MCP SDK, the AI SDK and the Claude Agent SDK are all strongest in TS.
- **Python owns the voice.** We first planned a Rust voice engine (§4 of v0). In practice, Kokoro needs an espeak phonemizer, and whisper.cpp needs CUDA and clang toolchains to build on Windows. With Python, `faster-whisper` ships CUDA as pip wheels and `kokoro-onnx` bundles espeak. `uv` makes it a one-command install. The wake word runs the openWakeWord ONNX models directly on onnxruntime, which avoids openwakeword's Linux-only dependencies.
- **Clean shutdown.**
  - On quit, the host closes each sidecar's stdin, and the core then stops OpenCode by killing its whole process tree.
  - On Windows, a Job Object kills every child process, even if Jarvis crashes.

---

## 3. The brain: OpenCode

The core launches its **own private `opencode serve`** on a free port, so it never clashes with your own OpenCode. Through `OPENCODE_CONFIG_CONTENT`, the core adds three things, which merge with your OpenCode config and login:
1. A primary agent called **`jarvis`**, with Jarvis's persona and voice-friendly permissions:
   - `bash`, `edit` and `external_directory` are set to **ask**.
   - `question` is denied, because a voice assistant can't answer multiple-choice prompts.
   - Reading files and fetching web pages are allowed.
2. **Jarvis's tools as a remote MCP server** on 127.0.0.1, protected by a random bearer token. They show up in OpenCode as `jarvis_web_search`, `jarvis_open_app`, `jarvis_open_url` and `jarvis_claude_code`.
3. An optional `opencode.model` (`provider/model`). Without it, OpenCode's default model is used.

How a turn works:
- OpenCode's `permission.asked` events, with a polling backup, are turned into spoken questions. Jarvis says something like *"I'd like to run a command to clean your downloads folder. Should I go ahead?"*, and your yes or no is sent back as the reply.
- Text arrives as `message.part.delta` events. The core streams it **sentence by sentence** into the voice, so Jarvis starts talking before OpenCode has finished writing.
- OpenCode's event stream can lag in folders that aren't git repos. To stay correct, deltas only count when they belong to the current turn's user message, and anything the stream missed is spoken from the final response.
- OpenCode works in **`~/.hey-jarvis/workspace`**, a small git repo that Jarvis creates. Events stream in real time there, and OpenCode doesn't index your whole home folder. The prompt tells the model where your own files are.

The **native loop** (AI SDK on BYOK, Ollama or OpenCode Zen) remains available with `"brain": "native"`.

---

## 4. Voice pipeline (apps/voice)

| Stage | Implementation | Notes |
|---|---|---|
| Capture | `sounddevice` at 16 kHz mono | Resamples if the device can't do 16 kHz |
| Wake word | openWakeWord `hey_jarvis` ONNX models (melspectrogram → embedding → head) on onnxruntime | CPU. Tested: about 0.99 on "Hey Jarvis", 0.00 on other speech |
| End of speech | Silero VAD v4 (ONNX) | 800 ms of silence; 5 s to start talking; 20 s maximum |
| STT | `faster-whisper` `small.en`, CUDA float16 with automatic CPU int8 fallback | About 1 GB VRAM; filters out common Whisper hallucinations |
| TTS | Kokoro-82M ONNX, `af_heart` | CPU, about 0.4× real time; synthesises the next sentence while the current one plays |
| Barge-in | Saying "Hey Jarvis" while Jarvis talks (score ≥ 0.8) cuts the speech | A higher bar so Jarvis's own voice can't wake it |
| Reply window | After a question (`expectReply`), the mic stays open about 8 s without the wake word | Used for voice confirmations |

Models (about 330 MB, plus Whisper) download to `~/.hey-jarvis/models` on first run, or ahead of time with `scripts/setup.ps1`.

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
| **M0** | Spec + scaffold ✅ | Monorepo builds, the core runs headless over stdio, the pill renders its states, tests pass |
| **M1** | **Voice loop** ✅ | "Hey Jarvis …" → wake → Whisper → OpenCode brain + Jarvis MCP tools → streamed Kokoro speech; voice confirmations for risky actions |
| **M2** | Core tools | Apps, files, shell and Claude Code via the Agent SDK, with voice confirmation working end to end |
| **M3** | Screen | Screenshot + vision model, pointer overlay, click and type with confirmation, accessibility-tree reading |
| **M4** | Accounts | OAuth connections, email, calendar, Slack, social posting (APIs plus the browser fallback) |
| **M5** | Memory and extensibility | SQLite memory, routines, MCP client, skills, `build_tool` |
| **M6** | Polish and sync | macOS notch mode, cloud sync, plugin marketplace, installers and auto-update |

---

## 9. Risks and open questions

- **Python sidecar packaging.** Development uses `uv run`. Release builds will need a frozen voice binary, or a `uv`-bootstrapped install (M6).
- **CUDA on Windows.** faster-whisper uses pip-installed cuBLAS and cuDNN, made visible with `os.add_dll_directory`. If CUDA fails to load, it falls back to the CPU automatically.
- **OpenCode latency.** OpenCode's coding-agent overhead adds a little time compared with a bare model call. Pick a fast `opencode.model` for voice.
- **X/Twitter posting.** The API is paid, so it goes through the browser fallback, which may break when their UI changes and is against their terms of service. Use it with care.
- **Screen control on Wayland.** Input injection and screenshots are restricted. It needs portals or ydotool, and is best effort.
- **Prompt injection.** Content from web pages or emails could try to make Jarvis act. Mitigations: risky tools always need confirmation, and tool output is always treated as data, never as instructions.
- **To decide later:** default model for the native loop (the user picks one at first run), cloud sync provider, marketplace format.
