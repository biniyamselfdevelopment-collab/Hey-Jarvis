import type { JarvisConfig } from "../config.js";
import { decide, type PermissionGate } from "../permissions.js";
import type { CoreMessage } from "../protocol.js";
import type { JarvisTool } from "./types.js";

/**
 * Runs Jarvis tools with policy + confirmation + activity reporting.
 * Shared by the native loop (AI SDK) and the MCP server OpenCode talks to.
 */
export class ToolRunner {
  constructor(
    readonly tools: JarvisTool[],
    private readonly config: JarvisConfig,
    private readonly gate: PermissionGate,
    private readonly send: (msg: CoreMessage) => void,
    private readonly callHost: (name: string, args: unknown) => Promise<unknown>,
  ) {}

  get(name: string): JarvisTool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  async run(name: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const tool = this.get(name);
    if (!tool) return { error: `Unknown tool ${name}` };
    const parsed = tool.input.safeParse(raw ?? {});
    if (!parsed.success) return { error: `Invalid input for ${name}: ${parsed.error.message}` };
    const input = parsed.data;

    const decision = decide(tool.risk, this.config.toolPolicies[tool.name]);
    if (decision === "deny") return { error: `The user has disabled ${tool.name}.` };
    if (decision === "confirm" && !(await this.gate.request(tool.name, tool.describe(input)))) {
      return { cancelled: true, note: "The user declined. Do not retry unless they ask again." };
    }

    this.send({ type: "state", state: "working" });
    this.send({ type: "tool_activity", tool: tool.name, status: "started", detail: tool.describe(input) });
    try {
      const output = await tool.run(input, {
        signal,
        progress: (detail) => this.send({ type: "tool_activity", tool: tool.name, status: "started", detail }),
        callHost: this.callHost,
      });
      this.send({ type: "tool_activity", tool: tool.name, status: "done" });
      return output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: "tool_activity", tool: tool.name, status: "error", detail: message });
      return { error: message };
    } finally {
      this.send({ type: "state", state: "thinking" });
    }
  }
}
