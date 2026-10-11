import { randomUUID } from "node:crypto";
import type { Brain } from "./brains/types.js";
import { PermissionGate } from "./permissions.js";
import type { CoreMessage, HostMessage } from "./protocol.js";

/** One Jarvis conversation: routes host messages, runs turns on the brain, gates risky actions. */
export class Jarvis {
  readonly gate: PermissionGate;
  brain: Brain | null = null;
  private turn: { abort: AbortController; done: Promise<void> } | null = null;
  private hostCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly send: (msg: CoreMessage) => void) {
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
        this.turn?.abort.abort();
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

  callHost = (name: string, args: unknown): Promise<unknown> => {
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      this.hostCalls.set(callId, { resolve, reject });
      this.send({ type: "host_tool_call", callId, name, args });
    });
  };

  private async runTurn(text: string): Promise<void> {
    // A new request replaces whatever Jarvis was doing.
    const previous = this.turn;
    if (previous) {
      previous.abort.abort();
      await previous.done.catch(() => {});
    }

    const brain = this.brain;
    if (!brain) {
      this.send({
        type: "speak",
        text: "I don't have a brain to think with yet. Install OpenCode, or add a model in settings, and I'm all yours.",
      });
      this.send({ type: "state", state: "idle" });
      return;
    }

    const abort = new AbortController();
    const done = (async () => {
      this.send({ type: "state", state: "thinking" });
      try {
        const result = await brain.turn(text, {
          signal: abort.signal,
          say: (sentence) => this.send({ type: "speak", text: sentence }),
        });
        if (!abort.signal.aborted && !result.spoke && result.text) this.send({ type: "speak", text: result.text });
      } catch (err) {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        this.send({ type: "error", message });
        this.send({ type: "speak", text: "Hmm, something went wrong on my end. Want me to try again?" });
      } finally {
        if (this.turn?.abort === abort) {
          this.turn = null;
          this.send({ type: "state", state: "idle" });
        }
      }
    })();
    this.turn = { abort, done };
    await done;
  }
}
