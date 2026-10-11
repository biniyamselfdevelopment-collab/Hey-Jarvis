/**
 * The JSON-lines protocol between the Tauri host (Rust) and the agent core.
 * One JSON object per line on stdin (host → core) and stdout (core → host).
 * Logs go to stderr so they never corrupt the stream.
 */
import { z } from "zod";

export const HostMessage = z.discriminatedUnion("type", [
  /** A finished utterance: Whisper transcript or typed text. */
  z.object({ type: z.literal("utterance"), id: z.string(), text: z.string(), source: z.enum(["voice", "typed"]) }),
  /** A click on Approve / Cancel in the pill. Voice answers arrive as plain utterances. */
  z.object({ type: z.literal("confirm_response"), requestId: z.string(), approved: z.boolean() }),
  /** User said "stop" / barged in / pressed Esc. */
  z.object({ type: z.literal("cancel") }),
  /** Result of a host-side tool (screenshot, click, keychain…) the core asked for. */
  z.object({ type: z.literal("host_tool_result"), callId: z.string(), ok: z.boolean(), result: z.unknown() }),
]);
export type HostMessage = z.infer<typeof HostMessage>;

export type JarvisState = "idle" | "listening" | "thinking" | "speaking" | "confirm" | "working";

export type CoreMessage =
  | { type: "ready"; brains: BrainSummary[] }
  | { type: "state"; state: JarvisState }
  /** Text Jarvis should say out loud (host runs TTS) and show as a caption. */
  | { type: "speak"; text: string; expectReply?: boolean }
  /** Non-spoken status for the pill (e.g. "Starting OpenCode…"). */
  | { type: "notice"; text: string }
  | { type: "tool_activity"; tool: string; status: "started" | "done" | "error"; detail?: string }
  | { type: "confirm_request"; requestId: string; tool: string; summary: string; detail?: string }
  /** Ask the host to run a native tool (screen, input, keychain). */
  | { type: "host_tool_call"; callId: string; name: string; args: unknown }
  | { type: "error"; message: string };

export interface BrainSummary {
  id: string;
  kind: "opencode" | "cli" | "byok";
  label: string;
  available: boolean;
}

export function encode(msg: CoreMessage): string {
  return JSON.stringify(msg) + "\n";
}

/** Parse one line from the host. Returns null (and never throws) on bad input. */
export function decode(line: string): HostMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = HostMessage.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
