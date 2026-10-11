import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreMessage, HostMessage, JarvisState } from "@hey-jarvis/core/protocol";

export interface ConfirmRequest {
  requestId: string;
  tool: string;
  summary: string;
  detail?: string;
}

export interface Caption {
  text: string;
  kind: "jarvis" | "you" | "info" | "error";
}

/** Extra messages the Rust host adds on top of the core protocol. */
type HostEvent =
  | { type: "heard"; text: string }
  | { type: "voice_status"; stage: "downloading" | "loading" | "ready" | "error"; message: string }
  | { type: "focus_input" };

type IncomingMessage = CoreMessage | HostEvent;

export interface JarvisView {
  state: JarvisState;
  caption: Caption | null;
  activity: string;
  confirm: ConfirmRequest | null;
  focusSignal: number;
  sendText: (text: string) => void;
  respond: (approved: boolean) => void;
  cancel: () => void;
  listen: () => void;
  reportHitRegion: (rect: DOMRect) => void;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke(cmd: string, args?: Record<string, unknown>) {
  if (!inTauri) return console.info("[demo]", cmd, args);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke(cmd, args);
}

const toCore = (message: HostMessage) => invoke("send_to_core", { message });

const CAPTION_MS: Record<Caption["kind"], number> = { jarvis: 4000, you: 2500, info: 3500, error: 8000 };

/** Bridges the pill to the agent core and voice (via Rust) — or plays a demo loop in a plain browser. */
export function useJarvis(): JarvisView {
  const [state, setState] = useState<JarvisState>("idle");
  const [caption, setCaptionState] = useState<Caption | null>(null);
  const [activity, setActivity] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const captionTimer = useRef<number>(undefined);

  const setCaption = useCallback((c: Caption) => {
    setCaptionState(c);
    window.clearTimeout(captionTimer.current);
    captionTimer.current = window.setTimeout(() => setCaptionState(null), CAPTION_MS[c.kind] + c.text.length * 50);
  }, []);

  const onMessage = useCallback(
    (msg: IncomingMessage) => {
      switch (msg.type) {
        case "state":
          setState(msg.state);
          if (msg.state !== "confirm") setConfirm(null);
          if (msg.state === "idle") setActivity("");
          break;
        case "speak":
          setCaption({ text: msg.text, kind: "jarvis" });
          break;
        case "heard":
          setCaption({ text: msg.text, kind: "you" });
          break;
        case "notice":
          setCaption({ text: msg.text, kind: "info" });
          break;
        case "voice_status":
          setCaption({ text: msg.message, kind: msg.stage === "error" ? "error" : "info" });
          break;
        case "confirm_request":
          setConfirm({ requestId: msg.requestId, tool: msg.tool, summary: msg.summary, detail: msg.detail });
          break;
        case "tool_activity":
          if (msg.status === "started") setActivity(msg.detail ?? msg.tool);
          break;
        case "focus_input":
          setFocusSignal((n) => n + 1);
          break;
        case "error":
          console.error("[jarvis]", msg.message);
          setCaption({ text: msg.message, kind: "error" });
          break;
      }
    },
    [setCaption],
  );

  useEffect(() => {
    if (!inTauri) return playDemo(onMessage);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<IncomingMessage>("core-message", (e) => onMessage(e.payload)).then((u) => {
        if (disposed) u();
        else unlisten = u;
      }),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onMessage]);

  return {
    state,
    caption,
    activity,
    confirm,
    focusSignal,
    sendText: (text) => void toCore({ type: "utterance", id: crypto.randomUUID(), text, source: "typed" }),
    respond: (approved) => {
      if (confirm) void toCore({ type: "confirm_response", requestId: confirm.requestId, approved });
    },
    cancel: () => void toCore({ type: "cancel" }),
    listen: () => void invoke("listen"),
    reportHitRegion: (r) => void invoke("set_hit_region", { x: r.x, y: r.y, width: r.width, height: r.height }),
  };
}

/** Cycles through every pill state so the UI can be designed in a normal browser (`pnpm vite`). */
function playDemo(emit: (m: IncomingMessage) => void): () => void {
  // Each step: emit these messages, then hold for N ms.
  const script: [IncomingMessage[], number][] = [
    [[{ type: "state", state: "idle" }], 1500],
    [[{ type: "state", state: "listening" }], 2000],
    [
      [
        { type: "state", state: "thinking" },
        { type: "heard", text: "What's the weather in Addis?" },
      ],
      1500,
    ],
    [
      [
        { type: "state", state: "working" },
        { type: "tool_activity", tool: "web_search", status: "started", detail: 'Searching "weather in Addis Ababa"' },
      ],
      2000,
    ],
    [
      [
        { type: "state", state: "speaking" },
        { type: "speak", text: "It's 22 degrees and sunny in Addis right now — perfect walking weather." },
      ],
      4000,
    ],
    [
      [
        { type: "state", state: "confirm" },
        {
          type: "confirm_request",
          requestId: "demo",
          tool: "opencode:bash",
          summary: "I'd like to run a command to clean up your downloads folder.",
          detail: "Remove-Item ~/Downloads/*.tmp",
        },
      ],
      5000,
    ],
  ];
  let i = 0;
  let timer: number;
  const step = () => {
    const [messages, hold] = script[i++ % script.length]!;
    messages.forEach(emit);
    timer = window.setTimeout(step, hold);
  };
  timer = window.setTimeout(step, 800);
  return () => window.clearTimeout(timer);
}
