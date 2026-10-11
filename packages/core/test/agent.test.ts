import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Jarvis } from "../src/agent.js";
import { JarvisConfig } from "../src/config.js";
import type { CoreMessage } from "../src/protocol.js";
import { defineTool } from "../src/tools/types.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** A model that calls `post` once, then replies with text. */
function scriptedModel() {
  let call = 0;
  return new MockLanguageModelV2({
    doGenerate: async () =>
      call++ === 0
        ? {
            content: [{ type: "tool-call", toolCallId: "c1", toolName: "post", input: JSON.stringify({ text: "hello world" }) }],
            finishReason: "tool-calls",
            usage,
            warnings: [],
          }
        : { content: [{ type: "text", text: "All done!" }], finishReason: "stop", usage, warnings: [] },
  });
}

function setup() {
  const sent: CoreMessage[] = [];
  const posted: string[] = [];
  const post = defineTool({
    name: "post",
    description: "Post to social media",
    risk: "high",
    input: z.object({ text: z.string() }),
    describe: ({ text }) => `I'll post "${text}".`,
    run: async ({ text }) => {
      posted.push(text);
      return { ok: true };
    },
  });
  const jarvis = new Jarvis(JarvisConfig.parse({}), (m) => sent.push(m), [post], scriptedModel());
  return { jarvis, sent, posted };
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe("Jarvis turn with a risky tool", () => {
  it("asks for confirmation, runs on a spoken yes, then speaks the answer", async () => {
    const { jarvis, sent, posted } = setup();
    const turn = jarvis.handle({ type: "utterance", id: "1", text: "post hello world", source: "voice" });
    await waitFor(() => jarvis.gate.waiting);
    expect(sent).toContainEqual({ type: "speak", text: 'I\'ll post "hello world". Should I go ahead?' });
    expect(posted).toEqual([]);

    await jarvis.handle({ type: "utterance", id: "2", text: "yes, go ahead", source: "voice" });
    await turn;
    expect(posted).toEqual(["hello world"]);
    expect(sent).toContainEqual({ type: "speak", text: "All done!" });
    expect(sent.at(-1)).toEqual({ type: "state", state: "idle" });
  });

  it("does not run the tool when the user says no", async () => {
    const { jarvis, sent, posted } = setup();
    const turn = jarvis.handle({ type: "utterance", id: "1", text: "post hello world", source: "voice" });
    await waitFor(() => jarvis.gate.waiting);
    await jarvis.handle({ type: "utterance", id: "2", text: "no wait", source: "voice" });
    await turn;
    expect(posted).toEqual([]);
    expect(sent).toContainEqual({ type: "speak", text: "Okay, cancelled." });
  });
});

describe("Jarvis without a model", () => {
  it("explains how to set one up", async () => {
    const sent: CoreMessage[] = [];
    const jarvis = new Jarvis(JarvisConfig.parse({}), (m) => sent.push(m), [], null);
    await jarvis.handle({ type: "utterance", id: "1", text: "hi", source: "typed" });
    expect(sent[0]).toMatchObject({ type: "speak" });
  });
});
