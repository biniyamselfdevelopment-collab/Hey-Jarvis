import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { JarvisView } from "./useJarvis";

const LABELS: Record<string, string> = {
  listening: "Listening…",
  thinking: "Thinking…",
  working: "On it…",
  speaking: "",
  confirm: "Should I go ahead?",
};

function Waveform() {
  return (
    <div className="wave" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
      <path
        fill="currentColor"
        d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"
      />
    </svg>
  );
}

export function Pill({ jarvis }: { jarvis: JarvisView }) {
  const { state, caption, activity, confirm } = jarvis;
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const pillRef = useRef<HTMLDivElement>(null);
  const expanded = state !== "idle" || typing;

  // Tell the host where the pill is, so the rest of the window lets clicks through.
  useLayoutEffect(() => {
    const el = pillRef.current;
    if (!el) return;
    const report = () => jarvis.reportHitRegion(el.getBoundingClientRect());
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    el.addEventListener("transitionend", report);
    return () => {
      observer.disconnect();
      el.removeEventListener("transitionend", report);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+Shift+K opens the text box.
  useEffect(() => {
    if (jarvis.focusSignal > 0) setTyping(true);
  }, [jarvis.focusSignal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state !== "idle") jarvis.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, jarvis]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) jarvis.sendText(draft.trim());
    setDraft("");
    setTyping(false);
  };

  return (
    <div className="stage">
      <div
        ref={pillRef}
        className={`pill pill--${state} ${expanded ? "pill--expanded" : ""} ${confirm ? "pill--tall" : ""}`}
        onClick={() => state !== "confirm" && setTyping(true)}
      >
        <div className="pill__row">
          <div className={`orb orb--${state}`} />
          {typing ? (
            <form onSubmit={submit} className="pill__form">
              <input
                autoFocus
                value={draft}
                placeholder="Ask Jarvis anything…"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => !draft && setTyping(false)}
                onKeyDown={(e) => e.key === "Escape" && setTyping(false)}
              />
              <button
                type="button"
                className="mic"
                title="Talk instead (Ctrl+Shift+J)"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setTyping(false);
                  jarvis.listen();
                }}
              >
                <MicIcon />
              </button>
            </form>
          ) : (
            expanded && <span className="pill__label">{activity && state === "working" ? activity : LABELS[state]}</span>
          )}
          {(state === "listening" || state === "speaking") && <Waveform />}
        </div>

        {confirm && (
          <div className="confirm">
            <p>{confirm.summary}</p>
            {confirm.detail && <code className="confirm__detail">{confirm.detail}</code>}
            <div className="confirm__actions">
              <button className="btn btn--ghost" onClick={() => jarvis.respond(false)}>
                Cancel
              </button>
              <button className="btn btn--go" onClick={() => jarvis.respond(true)}>
                Go ahead
              </button>
            </div>
            <small>…or just say "yes" or "no"</small>
          </div>
        )}
      </div>

      {caption && !confirm && (
        <div className={`caption caption--${caption.kind}`}>
          {caption.kind === "you" && <span className="caption__who">You</span>}
          {caption.text}
        </div>
      )}
    </div>
  );
}
