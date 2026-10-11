import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreMessage, HostMessage, JarvisState } from "@hey-jarvis/core/protocol";

export interface ConfirmRequest {
  requestId: string;
  tool: string;
  summary: string;
}

export interface JarvisView {
  state: JarvisState;
  caption: string;
  activity: string;
  confirm: ConfirmRequest | null;
  sendText: (text: string) => void;
  respond: (approved: boolean) => void;
  cancel: () => void;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function toCore(message: HostMessage) {
  if (!inTauri) return console.info("[demo] →core", message);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("send_to_core", { message });
}

/** Bridges the pill to the agent core (via Rust) — or plays a demo loop in a plain browser. */
export function useJarvis(): JarvisView {
  const [state, setState] = useState<JarvisState>("idle");
  const [caption, setCaption] = useState("");
  const [activity, setActivity] = useState("");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const captionTimer = useRef<number>(undefined);

  const onMessage = useCallback((msg: CoreMessage) => {
    switch (msg.type) {
      case "state":
        setState(msg.state);
        if (msg.state !== "confirm") setConfirm(null);
        if (msg.state === "idle") setActivity("");
        break;
      case "speak":
        setCaption(msg.text);
        window.clearTimeout(captionTimer.current);
        captionTimer.current = window.setTimeout(() => setCaption(""), 4000 + msg.text.length * 60);
        break;
      case "confirm_request":
        setConfirm({ requestId: msg.requestId, tool: msg.tool, summary: msg.summary });
        break;
      case "tool_activity":
        if (msg.status === "started") setActivity(msg.detail ?? msg.tool);
        break;
      case "error":
        console.error("[core]", msg.message);
        break;
    }
  }, []);

  useEffect(() => {
    if (!inTauri) return playDemo(onMessage);
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<CoreMessage>("core-message", (e) => onMessage(e.payload)).then((u) => (unlisten = u)),
    );
    return () => unlisten?.();
  }, [onMessage]);

  return {
    state,
    caption,
    activity,
    confirm,
    sendText: (text) => void toCore({ type: "utterance", id: crypto.randomUUID(), text, source: "typed" }),
    respond: (approved) => {
      if (confirm) void toCore({ type: "confirm_response", requestId: confirm.requestId, approved });
    },
    cancel: () => void toCore({ type: "cancel" }),
  };
}

/** Cycles through every pill state so the UI can be designed in a normal browser (`pnpm vite`). */
function playDemo(emit: (m: CoreMessage) => void): () => void {
  // Each step: emit these messages, then hold for N ms.
  const script: [CoreMessage[], number][] = [
    [[{ type: "state", state: "idle" }], 1500],
    [[{ type: "state", state: "listening" }], 2500],
    [[{ type: "state", state: "thinking" }], 1500],
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
        { type: "confirm_request", requestId: "demo", tool: "post", summary: 'I\'ll post "Shipping Hey Jarvis today 🚀" to X and LinkedIn.' },
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
