import { randomUUID } from "node:crypto";
import { dynamicTool, generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { JarvisConfig } from "./config.js";
import { decide, PermissionGate } from "./permissions.js";
import { systemPrompt } from "./persona.js";
import type { CoreMessage, HostMessage } from "./protocol.js";
import type { JarvisTool, ToolContext } from "./tools/types.js";

const MAX_HISTORY = 40;

/** One Jarvis conversation: routes host messages, runs turns, gates risky tools. */
export class Jarvis {
  readonly gate: PermissionGate;
  private history: ModelMessage[] = [];
  private turn: AbortController | null = null;
  private hostCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly config: JarvisConfig,
    private readonly send: (msg: CoreMessage) => void,
    private readonly tools: JarvisTool[],
    private readonly model: LanguageModel | null,
  ) {
    this.gate = new PermissionGate(send);
  }

  async handle(msg: HostMessage): Promise<void> {
    switch (msg.type) {
      case "utterance":
        // While a confirmation is pending, the next thing the user says answers it.
        if (this.gate.waiting) {
          this.gate.handleUtterance(msg.text);
          return;
        }
        return this.runTurn(msg.text);
      case "confirm_response":
        return this.gate.handleResponse(msg.requestId, msg.approved);
      case "cancel":
        this.gate.cancel();
        this.turn?.abort();
        this.send({ type: "state", state: "idle" });
        return;
      case "host_tool_result": {
        const call = this.hostCalls.get(msg.callId);
        this.hostCalls.delete(msg.callId);
        if (msg.ok) call?.resolve(msg.result);
        else call?.reject(new Error(String(msg.result)));
        return;
      }
    }
  }

  private async runTurn(text: string): Promise<void> {
    this.turn?.abort();
    const turn = new AbortController();
    this.turn = turn;

    if (!this.model) {
      // TODO(M1): route the turn through a delegate brain (OpenCode server / Claude Code) instead.
      this.send({ type: "speak", text: "I don't have a model to think with yet. Add one in settings and I'm all yours." });
      this.send({ type: "state", state: "idle" });
      return;
    }

    this.send({ type: "state", state: "thinking" });
    const messages: ModelMessage[] = [...this.history, { role: "user", content: text }];
    try {
      const result = await generateText({
        model: this.model,
        system: systemPrompt(this.config),
        messages,
        tools: this.toolSet(turn.signal),
        stopWhen: stepCountIs(this.config.maxSteps),
        abortSignal: turn.signal,
      });
      this.history = [...messages, ...result.response.messages].slice(-MAX_HISTORY);
      if (result.text.trim()) this.send({ type: "speak", text: result.text.trim() });
    } catch (err) {
      if (turn.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: "error", message });
      this.send({ type: "speak", text: "Hmm, something went wrong on my end. Want me to try again?" });
    } finally {
      if (this.turn === turn) {
        this.turn = null;
        this.send({ type: "state", state: "idle" });
      }
    }
  }

  private toolSet(signal: AbortSignal): ToolSet {
    const ctx: ToolContext = {
      signal,
      progress: (detail) => this.send({ type: "tool_activity", tool: "progress", status: "started", detail }),
      callHost: (name, args) => this.callHost(name, args),
    };
    const set: ToolSet = {};
    for (const t of this.tools) {
      set[t.name] = dynamicTool({
        description: t.description,
        inputSchema: t.input,
        execute: async (raw) => {
          const input = t.input.parse(raw);
          const decision = decide(t.risk, this.config.toolPolicies[t.name]);
          if (decision === "deny") return { error: `The user has disabled ${t.name}.` };
          if (decision === "confirm" && !(await this.gate.request(t.name, t.describe(input)))) {
            return { cancelled: true, note: "The user declined. Do not retry unless they ask again." };
          }
          this.send({ type: "state", state: "working" });
          this.send({ type: "tool_activity", tool: t.name, status: "started", detail: t.describe(input) });
          try {
            const output = await t.run(input, ctx);
            this.send({ type: "tool_activity", tool: t.name, status: "done" });
            return output;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.send({ type: "tool_activity", tool: t.name, status: "error", detail: message });
            return { error: message };
          } finally {
            this.send({ type: "state", state: "thinking" });
          }
        },
      });
    }
    return set;
  }

  private callHost(name: string, args: unknown): Promise<unknown> {
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      this.hostCalls.set(callId, { resolve, reject });
      this.send({ type: "host_tool_call", callId, name, args });
    });
  }
}
