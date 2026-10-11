import { homedir } from "node:os";
import { z } from "zod";
import { defineTool } from "./types.js";

export function codingTools() {
  const claudeCode = defineTool({
    name: "claude_code",
    description:
      "Hand a coding or multi-step computer task to Claude Code (runs locally with the user's Claude login). " +
      "Write a complete, self-contained prompt. Returns Claude's final report.",
    risk: "high",
    input: z.object({
      prompt: z.string().min(1).describe("Detailed instructions for Claude Code"),
      cwd: z.string().optional().describe("Project directory; defaults to the home folder"),
    }),
    describe: ({ prompt, cwd }) =>
      `I'll ask Claude Code to work${cwd ? ` in ${cwd}` : ""} on: ${prompt.length > 140 ? prompt.slice(0, 140) + "…" : prompt}.`,
    async run({ prompt, cwd }, { signal, progress }) {
      // Loaded lazily so the core still starts when Claude Code isn't installed.
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const abortController = new AbortController();
      signal.addEventListener("abort", () => abortController.abort(), { once: true });

      const run = query({
        prompt,
        options: { cwd: cwd ?? homedir(), permissionMode: "acceptEdits", abortController },
      });
      for await (const msg of run) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "tool_use") progress(`Claude Code: ${block.name}`);
          }
        } else if (msg.type === "result") {
          if (msg.subtype === "success") return { ok: !msg.is_error, report: msg.result, costUsd: msg.total_cost_usd };
          return { ok: false, report: `Claude Code stopped: ${msg.subtype}` };
        }
      }
      return { ok: false, report: "Claude Code ended without a result." };
    },
  });

  return [claudeCode];
}
