/**
 * Agent core entry point. Spawned by the Tauri host as a sidecar, or run
 * directly for headless testing:
 *
 *   pnpm core     # then type JSON lines, e.g.
 *   {"type":"utterance","id":"1","text":"what's the news today","source":"typed"}
 */
import { createInterface } from "node:readline";
import { Jarvis } from "./agent.js";
import { createModel, detectBrains, findOnPath } from "./brains/index.js";
import { NativeBrain } from "./brains/native.js";
import { OpencodeBrain } from "./brains/opencode.js";
import type { Brain } from "./brains/types.js";
import { loadConfig, type JarvisConfig } from "./config.js";
import { startMcpServer } from "./mcp.js";
import { decode, encode, type CoreMessage } from "./protocol.js";
import { codingTools } from "./tools/coding.js";
import { ToolRunner } from "./tools/runner.js";
import { systemTools } from "./tools/system.js";
import { webTools } from "./tools/web.js";

const send = (msg: CoreMessage): void => void process.stdout.write(encode(msg));

/** Tools OpenCode already has built-in equivalents of (with its own permission prompts). */
const OPENCODE_HAS = new Set(["fetch_page", "run_shell"]);

async function createBrain(config: JarvisConfig, jarvis: Jarvis): Promise<Brain | null> {
  const tools = [...webTools(config), ...systemTools(), ...codingTools()];
  const useNative = config.brain === "native" || (config.brain === "auto" && config.provider);
  if (useNative) {
    if (!config.provider) throw new Error('brain is "native" but no provider is configured');
    return new NativeBrain(createModel(config.provider), config, new ToolRunner(tools, config, jarvis.gate, send, jarvis.callHost));
  }

  if (!(await findOnPath("opencode"))) return null;
  send({ type: "notice", text: "Starting OpenCode…" });
  const runner = new ToolRunner(
    tools.filter((t) => !OPENCODE_HAS.has(t.name)),
    config,
    jarvis.gate,
    send,
    jarvis.callHost,
  );
  const mcp = await startMcpServer(runner);
  const brain = new OpencodeBrain({ config, mcp, gate: jarvis.gate, send });
  await brain.start();
  return brain;
}

async function main() {
  const config = await loadConfig();
  const jarvis = new Jarvis(send);

  // Accept messages right away; turns before the brain is ready get a friendly "not yet".
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const msg = decode(line);
    if (!msg) {
      console.error(`[core] ignoring malformed message: ${line.slice(0, 200)}`);
      return;
    }
    const p = jarvis.handle(msg).catch((err) => void send({ type: "error", message: String(err) }));
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });
  lines.on("close", async () => {
    await Promise.allSettled(pending);
    await jarvis.brain?.close?.();
    process.exit(0);
  });

  try {
    jarvis.brain = await createBrain(config, jarvis);
    send({ type: "notice", text: jarvis.brain ? `Thinking with ${jarvis.brain.label}` : "No brain configured" });
  } catch (err) {
    send({ type: "error", message: `Couldn't start the brain: ${err instanceof Error ? err.message : String(err)}` });
  }
  send({ type: "ready", brains: await detectBrains(config) });
}

main().catch((err) => {
  console.error("[core] fatal:", err);
  process.exit(1);
});
