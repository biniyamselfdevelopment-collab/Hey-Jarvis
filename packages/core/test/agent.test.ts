import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Jarvis } from "../src/agent.js";
import { NativeBrain } from "../src/brains/native.js";
import type { Brain } from "../src/brains/types.js";
import { JarvisConfig } from "../src/config.js";
import type { CoreMessage } from "../src/protocol.js";
import { ToolRunner } from "../src/tools/runner.js";
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
  const config = JarvisConfig.parse({});
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
  const send = (m: CoreMessage) => sent.push(m);
  const jarvis = new Jarvis(send);
  jarvis.brain = new NativeBrain(scriptedModel(), config, new ToolRunner([post], config, jarvis.gate, send, jarvis.callHost));
  return { jarvis, sent, posted };
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe("Jarvis turn with a risky tool (native brain)", () => {
  it("asks for confirmation, runs on a spoken yes, then speaks the answer", async () => {
    const { jarvis, sent, posted } = setup();
    const turn = jarvis.handle({ type: "utterance", id: "1", text: "post hello world", source: "voice" });
    await waitFor(() => jarvis.gate.waiting);
    expect(sent).toContainEqual({ type: "speak", text: 'I\'ll post "hello world". Should I go ahead?', expectReply: true });
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

describe("Jarvis turn handling", () => {
  it("explains how to set up a brain when there is none", async () => {
    const sent: CoreMessage[] = [];
    const jarvis = new Jarvis((m) => sent.push(m));
    await jarvis.handle({ type: "utterance", id: "1", text: "hi", source: "typed" });
    expect(sent[0]).toMatchObject({ type: "speak" });
  });

  it("does not repeat an answer the brain already streamed", async () => {
    const sent: CoreMessage[] = [];
    const jarvis = new Jarvis((m) => sent.push(m));
    jarvis.brain = {
      label: "stream",
      turn: async (_t, io) => {
        io.say("First sentence.");
        io.say("Second one.");
        return { text: "First sentence. Second one.", spoke: true };
      },
    } satisfies Brain;
    await jarvis.handle({ type: "utterance", id: "1", text: "hi", source: "voice" });
    expect(sent.filter((m) => m.type === "speak")).toEqual([
      { type: "speak", text: "First sentence." },
      { type: "speak", text: "Second one." },
    ]);
  });

  it("a new request aborts the one in progress", async () => {
    const sent: CoreMessage[] = [];
    const jarvis = new Jarvis((m) => sent.push(m));
    const aborted: string[] = [];
    jarvis.brain = {
      label: "slow",
      turn: (text, io) =>
        new Promise((resolve, reject) => {
          if (text === "second") return resolve({ text: "Second answer.", spoke: false });
          io.signal.addEventListener("abort", () => {
            aborted.push(text);
            reject(new Error("aborted"));
          });
        }),
    };
    const first = jarvis.handle({ type: "utterance", id: "1", text: "first", source: "voice" });
    await new Promise((r) => setTimeout(r, 5));
    await jarvis.handle({ type: "utterance", id: "2", text: "second", source: "voice" });
    await first;
    expect(aborted).toEqual(["first"]);
    expect(sent.filter((m) => m.type === "speak")).toEqual([{ type: "speak", text: "Second answer." }]);
    expect(sent.some((m) => m.type === "error")).toBe(false);
  });
});
