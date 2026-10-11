/**
 * Jarvis's tools as a local MCP server (Streamable HTTP on 127.0.0.1), so a
 * delegate brain like OpenCode can use them. Tools still run in this process,
 * through the same ToolRunner — risky ones still need a voice/click "yes".
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolRunner } from "./tools/runner.js";

export interface JarvisMcpServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function buildServer(runner: ToolRunner): Server {
  const server = new Server({ name: "jarvis", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: runner.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input, { io: "input" }) as { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const output = await runner.run(req.params.name, req.params.arguments, extra.signal);
    const isError = typeof output === "object" && output !== null && "error" in output;
    return {
      content: [{ type: "text" as const, text: typeof output === "string" ? output : JSON.stringify(output) }],
      isError,
    };
  });
  return server;
}

export async function startMcpServer(runner: ToolRunner): Promise<JarvisMcpServer> {
  const token = randomBytes(24).toString("hex");
  const http: HttpServer = createServer(async (req, res) => {
    if (!authorized(req, token)) {
      res.writeHead(401).end();
      return;
    }
    // Stateless: a fresh server/transport per request keeps things simple and robust.
    const server = buildServer(runner);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp] request failed:", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections(); // clients (OpenCode) keep connections alive
      }),
  };
}
