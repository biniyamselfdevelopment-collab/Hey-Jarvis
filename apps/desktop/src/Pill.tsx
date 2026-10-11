import { useState, type FormEvent } from "react";
import type { JarvisView } from "./useJarvis";

const LABELS: Record<string, string> = {
  listening: "Listening…",
  thinking: "Thinking…",
  working: "On it…",
  speaking: "",
  confirm: "Should I go ahead?",
};

function Waveform({ active }: { active: boolean }) {
  return (
    <div className={`wave ${active ? "wave--active" : ""}`} aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </div>
  );
}

export function Pill({ jarvis }: { jarvis: JarvisView }) {
  const { state, caption, activity, confirm } = jarvis;
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const expanded = state !== "idle" || typing || caption !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) jarvis.sendText(draft.trim());
    setDraft("");
    setTyping(false);
  };

  return (
    <div className="stage">
      <div
        className={`pill pill--${state} ${expanded ? "pill--expanded" : ""} ${confirm ? "pill--tall" : ""}`}
        onClick={() => state === "idle" && setTyping(true)}
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
            </form>
          ) : (
            expanded && <span className="pill__label">{activity && state === "working" ? activity : LABELS[state]}</span>
          )}
          {(state === "listening" || state === "speaking") && <Waveform active />}
        </div>

        {confirm && (
          <div className="confirm">
            <p>{confirm.summary}</p>
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

      {caption && !confirm && <div className="caption">{caption}</div>}
    </div>
  );
}
