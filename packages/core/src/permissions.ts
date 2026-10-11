import { randomUUID } from "node:crypto";
import type { ToolPolicy } from "./config.js";
import type { CoreMessage } from "./protocol.js";

/**
 * low    – runs silently (search, read)
 * medium – runs, Jarvis mentions it (open app, create draft)
 * high   – needs a voice or click confirmation (post, send, shell, click, delete, buy)
 */
export type Risk = "low" | "medium" | "high";
export type Decision = "run" | "confirm" | "deny";

export function decide(risk: Risk, override?: ToolPolicy): Decision {
  if (override === "deny") return "deny";
  if (override === "allow") return "run";
  if (override === "ask") return "confirm";
  return risk === "high" ? "confirm" : "run";
}

export type ConfirmAnswer = "yes" | "no" | "unclear";

// Negatives win over positives: "yes— wait, no" must never post.
const NEGATIVE =
  /\b(no|nope|nah|don'?t|do not|cancel|stop|wait|hold on|hang on|never ?mind|not now|abort|scratch that)\b/;
const POSITIVE =
  /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|send it|post it|ship it|confirm(ed)?|approved?|absolutely|please do|sounds good|affirmative|proceed)\b/;

/** Interpret a spoken answer to "Should I go ahead?". */
export function parseConfirmation(text: string): ConfirmAnswer {
  const t = text.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z' ]+/g, " ");
  if (NEGATIVE.test(t)) return "no";
  if (POSITIVE.test(t)) return "yes";
  return "unclear";
}

interface Pending {
  requestId: string;
  tool: string;
  summary: string;
  reasked: boolean;
  resolve: (approved: boolean) => void;
}

/**
 * Holds risky tool calls until the user approves by voice or click.
 * Only one confirmation is pending at a time; tools run sequentially.
 */
export class PermissionGate {
  private pending: Pending | null = null;

  constructor(private readonly send: (msg: CoreMessage) => void) {}

  get waiting(): boolean {
    return this.pending !== null;
  }

  request(tool: string, summary: string, detail?: string): Promise<boolean> {
    if (this.pending) this.settle(false);
    return new Promise((resolve) => {
      const requestId = randomUUID();
      this.pending = { requestId, tool, summary, reasked: false, resolve };
      this.send({ type: "state", state: "confirm" });
      this.send({ type: "confirm_request", requestId, tool, summary, ...(detail ? { detail } : {}) });
      this.send({ type: "speak", text: `${summary} Should I go ahead?`, expectReply: true });
    });
  }

  /** Feed a voice utterance. Returns true if it was consumed as a confirmation answer. */
  handleUtterance(text: string): boolean {
    const p = this.pending;
    if (!p) return false;
    const answer = parseConfirmation(text);
    if (answer === "unclear" && !p.reasked) {
      p.reasked = true;
      this.send({ type: "speak", text: "Sorry, was that a yes or a no?", expectReply: true });
      return true;
    }
    if (answer !== "yes") this.send({ type: "speak", text: "Okay, cancelled." });
    this.settle(answer === "yes");
    return true;
  }

  handleResponse(requestId: string, approved: boolean): void {
    if (this.pending?.requestId === requestId) this.settle(approved);
  }

  cancel(): void {
    if (this.pending) this.settle(false);
  }

  private settle(approved: boolean): void {
    const p = this.pending;
    this.pending = null;
    p?.resolve(approved);
  }
}
