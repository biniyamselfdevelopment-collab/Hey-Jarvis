/**
 * Drives the REAL OpenCode binary (must be on PATH) against a scripted mock LLM.
 * Verifies: Jarvis agent + persona injection, MCP tools, the voice gate for
 * Jarvis tools and for OpenCode's own bash permission, and streamed speech.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { findOnPath } from "../src/brains/index.js";
import { OpencodeBrain } from "../src/brains/opencode.js";
import { JarvisConfig } from "../src/config.js";
import { startMcpServer, type JarvisMcpServer } from "../src/mcp.js";
import { PermissionGate } from "../src/permissions.js";
import type { CoreMessage } from "../src/protocol.js";
import { ToolRunner } from "../src/tools/runner.js";
import { defineTool } from "../src/tools/types.js";
import { mockProviderConfig, startMockLlm, textOf, type ChatMessage } from "./helpers/mock-llm.js";

const hasOpencode = await findOnPath("opencode");

function script(messages: ChatMessage[]) {
  const user = textOf([...messages].reverse().find((m) => m.role === "user"));
  const last = messages.at(-1)!;
  if (last.role === "tool") {
    const out = textOf(last);
    if (user.includes("shell")) return { text: `The command printed ${out.trim()}.` };
    return { text: "Done! I posted it. Anything else?" };
  }
  if (user.includes("post")) return { tool: "jarvis_post", args: { text: "hello world" } };
  if (user.includes("shell")) return { tool: "bash", args: { command: "echo jarvis-ok", description: "Print a test word" } };
  if (messages[0] && textOf(messages[0]).includes("title")) return { text: "Chat" };
  return { text: "Hi there, I'm your mock brain. What can I do for you today?" };
}

describe.skipIf(!hasOpencode)("OpencodeBrain with the real OpenCode binary", () => {
  let llm: Awaited<ReturnType<typeof startMockLlm>>;
  let mcp: JarvisMcpServer;
  let brain: OpencodeBrain;
  const sent: CoreMessage[] = [];
  const posted: string[] = [];
  const gate = new PermissionGate((m) => sent.push(m));

  beforeAll(async () => {
    // Isolate OpenCode's config/data from the developer's real setup.
    const home = mkdtempSync(join(tmpdir(), "jarvis-oc-"));
    for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) process.env[k] = join(home, k);
    llm = await startMockLlm(script);
    const config = JarvisConfig.parse({ opencode: { directory: home, config: mockProviderConfig(llm.baseURL) } });
    const post = defineTool({
      name: "post",
      description: "Post to social media",
      risk: "high",
      input: z.object({ text: z.string() }),
      describe: ({ text }) => `I'll post "${text}".`,
      run: async ({ text }) => (posted.push(text), { posted: true }),
    });
    mcp = await startMcpServer(new ToolRunner([post], config, gate, (m) => sent.push(m), async () => null));
    brain = new OpencodeBrain({ config, mcp, gate, send: (m) => sent.push(m) });
    await brain.start();
  }, 120_000);

  afterAll(async () => {
    await brain?.close();
    await mcp?.close();
    await llm?.close();
  });

  const turn = (text: string) => {
    const said: string[] = [];
    const result = brain.turn(text, { signal: new AbortController().signal, say: (s) => said.push(s) });
    return { said, result };
  };
  const answerWhenAsked = async (answer: string) => {
    for (let i = 0; i < 400 && !gate.waiting; i++) await new Promise((r) => setTimeout(r, 50));
    expect(gate.waiting).toBe(true);
    gate.handleUtterance(answer);
  };

  it("streams the answer sentence by sentence using the Jarvis persona", async () => {
    const { said, result } = turn("hello");
    const r = await result;
    expect(r.spoke).toBe(true);
    expect(said).toEqual(["Hi there, I'm your mock brain.", "What can I do for you today?"]);
    expect(JSON.stringify(llm.requests.at(-1)?.[0])).toContain("friendly helper");
  }, 60_000);

  it("runs a risky Jarvis MCP tool only after a spoken yes", async () => {
    const { said, result } = turn("please post hello world");
    await answerWhenAsked("yes, go ahead");
    await result;
    expect(posted).toEqual(["hello world"]);
    expect(sent).toContainEqual(expect.objectContaining({ type: "speak", text: 'I\'ll post "hello world". Should I go ahead?', expectReply: true }));
    expect(said.join(" ")).toContain("Done! I posted it.");
  }, 60_000);

  it("routes OpenCode's bash permission through the voice gate (approve)", async () => {
    const { said, result } = turn("run a shell check");
    await answerWhenAsked("yep");
    await result;
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "confirm_request", tool: "opencode:bash", summary: "I'd like to run a command to print a test word.", detail: "echo jarvis-ok" }),
    );
    expect(said.join(" ")).toContain("printed jarvis-ok");
  }, 60_000);

  it("rejects OpenCode's bash permission on a spoken no, and stays quiet afterwards", async () => {
    const llmCalls = llm.requests.length;
    const { said, result } = turn("run another shell check");
    await answerWhenAsked("no, don't");
    const r = await result;
    expect(sent.at(-1)).toEqual({ type: "speak", text: "Okay, cancelled." });
    // OpenCode stops the turn on a rejection: the command never ran and nothing stale is spoken.
    expect(llm.requests.slice(llmCalls).some((m) => textOf(m.at(-1)).includes("jarvis-ok"))).toBe(false);
    expect(said).toEqual([]);
    expect(r.spoke).toBe(false);
  }, 60_000);
});
