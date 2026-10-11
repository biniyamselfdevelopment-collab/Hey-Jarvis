import { dynamicTool, generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { JarvisConfig } from "../config.js";
import { systemPrompt } from "../persona.js";
import type { ToolRunner } from "../tools/runner.js";
import type { Brain, TurnIO, TurnResult } from "./types.js";

const MAX_HISTORY = 40;

/** Jarvis's own tool-calling loop on any AI SDK model (BYOK / Ollama / OpenCode Zen). */
export class NativeBrain implements Brain {
  readonly label: string;
  private history: ModelMessage[] = [];

  constructor(
    private readonly model: LanguageModel,
    private readonly config: JarvisConfig,
    private readonly runner: ToolRunner,
  ) {
    this.label = typeof model === "string" ? model : model.modelId;
  }

  async turn(text: string, io: TurnIO): Promise<TurnResult> {
    const messages: ModelMessage[] = [...this.history, { role: "user", content: text }];
    const result = await generateText({
      model: this.model,
      system: systemPrompt(this.config, "native"),
      messages,
      tools: this.toolSet(),
      stopWhen: stepCountIs(this.config.maxSteps),
      abortSignal: io.signal,
    });
    this.history = [...messages, ...result.response.messages].slice(-MAX_HISTORY);
    return { text: result.text.trim(), spoke: false };
  }

  private toolSet(): ToolSet {
    const set: ToolSet = {};
    for (const t of this.runner.tools) {
      set[t.name] = dynamicTool({
        description: t.description,
        inputSchema: t.input,
        execute: (input, { abortSignal }) => this.runner.run(t.name, input, abortSignal ?? new AbortController().signal),
      });
    }
    return set;
  }
}
