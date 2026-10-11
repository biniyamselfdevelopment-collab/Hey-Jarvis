/**
 * OpenCode as Jarvis's brain.
 *
 * Jarvis launches a private `opencode serve`, injecting (via OPENCODE_CONFIG_CONTENT,
 * which merges with the user's own OpenCode config and login):
 *   - a "jarvis" primary agent with Jarvis's persona and voice-friendly permissions
 *   - Jarvis's own tools as a remote MCP server (web search, apps, Claude Code…)
 * OpenCode's permission requests (shell commands, file edits) are routed to the
 * same voice/click confirmation gate as Jarvis's own risky tools.
 */
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename } from "node:path";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createOpencodeServer } from "@opencode-ai/sdk/v2/server";
import type { Config as OpencodeConfig, Event, Part } from "@opencode-ai/sdk/v2";
import type { JarvisConfig } from "../config.js";
import type { JarvisMcpServer } from "../mcp.js";
import type { PermissionGate } from "../permissions.js";
import { systemPrompt } from "../persona.js";
import type { CoreMessage } from "../protocol.js";
import { SentenceStream } from "../speech.js";
import type { Brain, TurnIO, TurnResult } from "./types.js";

export const AGENT = "jarvis";

/** OpenCode permission keys Jarvis's `toolPolicies` may override. */
const OVERRIDABLE = ["bash", "edit", "external_directory", "webfetch", "websearch", "read", "task"];

export function buildOpencodeConfig(config: JarvisConfig, mcp: Pick<JarvisMcpServer, "url" | "token">): OpencodeConfig {
  const permission: Record<string, "ask" | "allow" | "deny"> = {
    bash: "ask",
    edit: "ask",
    external_directory: "ask",
    doom_loop: "ask",
    // A voice assistant can't answer OpenCode's multiple-choice questions.
    question: "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    webfetch: "allow",
    websearch: "allow",
    todowrite: "allow",
    task: "allow",
    skill: "allow",
  };
  for (const key of OVERRIDABLE) {
    const override = config.toolPolicies[key];
    if (override) permission[key] = override;
  }
  const extra = (config.opencode.config ?? {}) as OpencodeConfig;
  return {
    ...extra,
    mcp: {
      ...extra.mcp,
      jarvis: { type: "remote", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` }, oauth: false, enabled: true },
    },
    agent: {
      ...extra.agent,
      [AGENT]: {
        mode: "primary",
        description: "Hey Jarvis — the voice assistant living on this computer",
        prompt: systemPrompt(config, "opencode"),
        ...(config.opencode.model ? { model: config.opencode.model } : {}),
        permission,
      },
    },
  };
}

interface PermissionAsk {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** What Jarvis says (and shows) when OpenCode asks for permission. */
export function describePermission(ask: Pick<PermissionAsk, "permission" | "patterns" | "metadata">): {
  summary: string;
  detail?: string;
} {
  const meta = ask.metadata;
  const str = (k: string) => (typeof meta[k] === "string" ? (meta[k] as string) : undefined);
  const target = str("filepath") ?? str("filePath") ?? str("path") ?? ask.patterns[0] ?? "";
  switch (ask.permission) {
    case "bash": {
      const command = str("command") ?? ask.patterns.join(" && ");
      const why = str("description");
      return { summary: why ? `I'd like to run a command to ${why.replace(/\.$/, "").toLowerCase()}.` : "I'd like to run a command.", detail: command };
    }
    case "edit":
    case "write":
      return { summary: `I'd like to change ${basename(target) || "a file"}.`, detail: target };
    case "external_directory":
      return { summary: `I need to work outside the current folder, in ${clip(target, 60)}.`, detail: target };
    case "doom_loop":
      return { summary: "I seem to be repeating the same step. Should I keep trying?" };
    default:
      return {
        summary: `OpenCode wants permission to use ${ask.permission.replace(/_/g, " ")}.`,
        detail: ask.patterns.join(", ") || undefined,
      };
  }
}

export interface OpencodeBrainOptions {
  config: JarvisConfig;
  mcp: Pick<JarvisMcpServer, "url" | "token">;
  gate: PermissionGate;
  send: (msg: CoreMessage) => void;
}

/** Text deltas for one part that we can't attribute to the current turn yet. */
interface PendingPart {
  messageID: string;
  text: string;
}

export class OpencodeBrain implements Brain {
  readonly label = "OpenCode";
  private client!: OpencodeClient;
  private server: { url: string; close(): void } | null = null;
  private sessionID: string | null = null;
  private events = new AbortController();

  // Per-turn streaming state. OpenCode's event stream can lag behind the prompt
  // response, so text is only spoken when it provably belongs to this turn, and
  // anything the stream missed is reconciled from the final response.
  private turnActive = false;
  private turnUserMessage: string | null = null;
  private speech: SentenceStream | null = null;
  private messageParent = new Map<string, string | null>();
  private partTypes = new Map<string, string>();
  private pending = new Map<string, PendingPart>();
  private streamed = new Map<string, string>();
  private handledPermissions = new Set<string>();
  private seenUserMessages = new Set<string>();
  /** Tool call inputs by callID, so permission prompts can say *why* (e.g. bash's description). */
  private toolInputs = new Map<string, Record<string, unknown>>();

  constructor(private readonly opts: OpencodeBrainOptions) {}

  async start(): Promise<void> {
    const { config } = this.opts;
    this.server = await createOpencodeServer({
      hostname: "127.0.0.1",
      // OpenCode treats --port=0 as its default 4096, which may clash with the user's own OpenCode.
      port: config.opencode.port || (await freePort()),
      timeout: 30_000,
      config: buildOpencodeConfig(config, this.opts.mcp),
    });
    this.client = createOpencodeClient({ baseUrl: this.server.url, directory: config.opencode.directory ?? homedir() });
    void this.listen();
  }

  async close(): Promise<void> {
    this.events.abort();
    this.server?.close();
  }

  /** Start a fresh conversation (e.g. "new chat"). */
  reset(): void {
    this.sessionID = null;
  }

  async turn(text: string, io: TurnIO): Promise<TurnResult> {
    const sessionID = await this.session();
    const speech = new SentenceStream(io.say);
    this.beginTurn(speech);
    const abort = () => void this.client.session.abort({ sessionID });
    io.signal.addEventListener("abort", abort, { once: true });
    const poller = setInterval(() => void this.pollPermissions(), 750);
    try {
      const res = await this.client.session.prompt({ sessionID, agent: AGENT, parts: [{ type: "text", text }] });
      if (res.error) throw new Error(`OpenCode: ${JSON.stringify(res.error)}`);
      const { info, parts } = res.data;
      if (info.error) throw new Error(`OpenCode: ${errorMessage(info.error)}`);
      const textParts = parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic);
      // Speak whatever the event stream didn't deliver in time.
      for (const part of textParts) {
        const already = this.streamed.get(part.id) ?? "";
        if (part.text.startsWith(already)) speech.push(part.text.slice(already.length) + "\n");
      }
      speech.flush();
      return { text: textParts.map((p) => p.text).join("\n").trim(), spoke: speech.spoke };
    } finally {
      clearInterval(poller);
      io.signal.removeEventListener("abort", abort);
      this.endTurn();
    }
  }

  private beginTurn(speech: SentenceStream): void {
    this.turnActive = true;
    this.turnUserMessage = null;
    this.speech = speech;
    this.messageParent.clear();
    this.partTypes.clear();
    this.pending.clear();
    this.streamed.clear();
  }

  private endTurn(): void {
    this.turnActive = false;
    this.speech = null;
    this.pending.clear();
  }

  private async session(): Promise<string> {
    if (this.sessionID) return this.sessionID;
    const res = await this.client.session.create({ title: "Hey Jarvis" });
    if (!res.data) throw new Error(`OpenCode: couldn't create a session: ${JSON.stringify(res.error)}`);
    this.sessionID = res.data.id;
    return this.sessionID;
  }

  private async listen(): Promise<void> {
    while (!this.events.signal.aborted) {
      try {
        const { stream } = await this.client.event.subscribe(undefined, { signal: this.events.signal });
        for await (const event of stream) this.onEvent(event as Event);
      } catch (err) {
        if (this.events.signal.aborted) return;
        console.error("[opencode] event stream dropped, reconnecting:", err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Exposed for tests. */
  onEvent(event: Event): void {
    const props = event.properties as { sessionID?: string };
    if (!props.sessionID || props.sessionID !== this.sessionID) return;

    switch (event.type) {
      case "permission.asked":
        void this.onPermission(event.properties as PermissionAsk);
        return;
      case "message.updated": {
        const info = event.properties.info;
        if (info.role === "user") {
          this.messageParent.set(info.id, null);
          // Only a never-seen user message can start this turn; late re-updates of older ones can't.
          if (!this.seenUserMessages.has(info.id)) {
            this.seenUserMessages.add(info.id);
            if (this.turnActive && this.turnUserMessage === null) this.turnUserMessage = info.id;
          }
        } else {
          this.messageParent.set(info.id, info.parentID);
        }
        break;
      }
      case "message.part.updated": {
        const part = event.properties.part;
        this.partTypes.set(part.id, part.type);
        if (part.type === "tool" && "input" in part.state) this.toolInputs.set(part.callID, part.state.input);
        if (part.type === "tool" && part.state.status === "running" && !part.tool.startsWith("jarvis_") && this.owns(part.messageID)) {
          this.opts.send({ type: "tool_activity", tool: part.tool, status: "started", detail: part.state.title ?? part.tool });
        }
        break;
      }
      case "message.part.delta": {
        const { partID, field, delta, messageID } = event.properties;
        if (field !== "text") return;
        const entry = this.pending.get(partID) ?? { messageID, text: "" };
        entry.text += delta;
        this.pending.set(partID, entry);
        break;
      }
      default:
        return;
    }
    this.drainPending();
  }

  /** True when a message is an assistant reply to the current turn's user message. */
  private owns(messageID: string): boolean {
    const parent = this.messageParent.get(messageID);
    return this.turnActive && parent != null && parent === this.turnUserMessage;
  }

  private drainPending(): void {
    if (!this.turnActive) return;
    for (const [partID, entry] of this.pending) {
      const type = this.partTypes.get(partID);
      const parent = this.messageParent.get(entry.messageID);
      if ((type !== undefined && type !== "text") || parent === null || (parent !== undefined && this.turnUserMessage && parent !== this.turnUserMessage)) {
        this.pending.delete(partID); // reasoning, the user's own text, or an older turn
        continue;
      }
      if (type !== "text" || !this.owns(entry.messageID)) continue; // not attributable yet
      this.pending.delete(partID);
      this.streamed.set(partID, (this.streamed.get(partID) ?? "") + entry.text);
      this.speech?.push(entry.text);
    }
  }

  private async pollPermissions(): Promise<void> {
    const res = await this.client.permission.list().catch(() => null);
    for (const ask of res?.data ?? []) {
      if (ask.sessionID === this.sessionID) void this.onPermission(ask as PermissionAsk);
    }
  }

  private async onPermission(ask: PermissionAsk): Promise<void> {
    if (this.handledPermissions.has(ask.id)) return;
    this.handledPermissions.add(ask.id);
    const input = ask.tool ? this.toolInputs.get(ask.tool.callID) : undefined;
    const { summary, detail } = describePermission({ ...ask, metadata: { ...input, ...ask.metadata } });
    const approved = await this.opts.gate.request(`opencode:${ask.permission}`, summary, detail);
    await this.client.permission.reply({ requestID: ask.id, reply: approved ? "once" : "reject" });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function errorMessage(error: unknown): string {
  const e = error as { name?: string; data?: { message?: string } };
  return e.data?.message ?? e.name ?? JSON.stringify(error);
}
