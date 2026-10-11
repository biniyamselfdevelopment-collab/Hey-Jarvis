/**
 * Agent core entry point. Spawned by the Tauri host as a sidecar, or run
 * directly for headless testing:
 *
 *   echo '{"type":"utterance","id":"1","text":"what is the news today","source":"typed"}' | pnpm core
 */
import { createInterface } from "node:readline";
import { Jarvis } from "./agent.js";
import { createModel, detectBrains } from "./brains/index.js";
import { loadConfig } from "./config.js";
import { decode, encode, type CoreMessage } from "./protocol.js";
import { codingTools } from "./tools/coding.js";
import { systemTools } from "./tools/system.js";
import { webTools } from "./tools/web.js";

const send = (msg: CoreMessage): void => void process.stdout.write(encode(msg));

async function main() {
  const config = await loadConfig();
  const model = config.provider ? createModel(config.provider) : null;
  const tools = [...webTools(config), ...systemTools(), ...codingTools()];
  const jarvis = new Jarvis(config, send, tools, model);

  send({ type: "ready", brains: await detectBrains(config) });

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
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[core] fatal:", err);
  process.exit(1);
});
