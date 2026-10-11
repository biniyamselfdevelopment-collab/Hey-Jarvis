/**
 * A tiny OpenAI-compatible chat completions server that plays a script, so the
 * real OpenCode binary can be driven deterministically in tests.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatMessage {
  role: string;
  content?: string | { type: string; text?: string }[] | null;
  tool_calls?: unknown[];
}

export type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
export type Script = (messages: ChatMessage[]) => Reply;

export const textOf = (m: ChatMessage | undefined): string =>
  !m?.content ? "" : typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("");

export async function startMockLlm(script: Script) {
  const requests: ChatMessage[][] = [];
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const payload = JSON.parse(body) as { messages: ChatMessage[]; stream?: boolean };
      requests.push(payload.messages);
      const reply = script(payload.messages);
      const id = `chatcmpl-${++calls}`;
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: "" }));
      if ("text" in reply) {
        for (const piece of reply.text.match(/.{1,12}/gs) ?? []) res.write(chunk({ content: piece }));
        res.write(chunk({}, "stop"));
      } else {
        res.write(
          chunk({
            tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }],
          }),
        );
        res.write(chunk({}, "tool_calls"));
      }
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** OpenCode config that registers the mock as provider "mock" with model "mock-1". */
export function mockProviderConfig(baseURL: string) {
  return {
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL, apiKey: "test" },
        models: { "mock-1": { name: "Mock 1", tool_call: true } },
      },
    },
    model: "mock/mock-1",
    small_model: "mock/mock-1",
  };
}
