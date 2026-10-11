import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JarvisConfig } from "../src/config.js";
import { startMcpServer, type JarvisMcpServer } from "../src/mcp.js";
import { PermissionGate } from "../src/permissions.js";
import type { CoreMessage } from "../src/protocol.js";
import { ToolRunner } from "../src/tools/runner.js";
import { defineTool } from "../src/tools/types.js";

const echo = defineTool({
  name: "echo",
  description: "Echo text back",
  risk: "low",
  input: z.object({ text: z.string() }),
  describe: ({ text }) => `Echo ${text}.`,
  run: async ({ text }) => ({ echoed: text }),
});
const wipe = defineTool({
  name: "wipe",
  description: "Delete everything",
  risk: "high",
  input: z.object({}),
  describe: () => "I'll delete everything.",
  run: async () => ({ wiped: true }),
});

let server: JarvisMcpServer | undefined;
afterEach(async () => server?.close());

async function connect(token: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server!.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

describe("Jarvis MCP server", () => {
  it("lists and runs tools for an authorised client, gating risky ones", async () => {
    const sent: CoreMessage[] = [];
    const gate = new PermissionGate((m) => sent.push(m));
    server = await startMcpServer(new ToolRunner([echo, wipe], JarvisConfig.parse({}), gate, (m) => sent.push(m), async () => null));
    const client = await connect(server.token);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "wipe"]);
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });

    const res = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(res.content).toEqual([{ type: "text", text: '{"echoed":"hi"}' }]);

    const risky = client.callTool({ name: "wipe", arguments: {} });
    for (let i = 0; i < 100 && !gate.waiting; i++) await new Promise((r) => setTimeout(r, 10));
    gate.handleUtterance("no");
    const declined = await risky;
    expect(JSON.stringify(declined.content)).toContain("cancelled");
    await client.close();
  });

  it("rejects clients without the token", async () => {
    const gate = new PermissionGate(() => {});
    server = await startMcpServer(new ToolRunner([echo], JarvisConfig.parse({}), gate, () => {}, async () => null));
    await expect(connect("wrong")).rejects.toThrow();
  });
});
