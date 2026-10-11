import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ProviderConfig = z.object({
  /** Preset id: "openai", "openrouter", "opencode-zen", "ollama", "anthropic", or "custom". */
  preset: z.string(),
  model: z.string(),
  baseURL: z.string().url().optional(),
  /** Name of the env var holding the key. Real keys live in the OS keychain (fed in by the host). */
  apiKeyEnv: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const ToolPolicy = z.enum(["allow", "ask", "deny"]);
export type ToolPolicy = z.infer<typeof ToolPolicy>;

export const JarvisConfig = z.object({
  name: z.string().default("Jarvis"),
  /** How Jarvis addresses the user. Empty means by no special title. */
  userName: z.string().default(""),
  /** Fast model for the native loop. Unset → route turns through a delegate brain. */
  provider: ProviderConfig.optional(),
  opencode: z
    .object({ baseURL: z.string().url().default("http://localhost:4096") })
    .default({ baseURL: "http://localhost:4096" }),
  search: z
    .object({
      provider: z.enum(["duckduckgo", "brave"]).default("duckduckgo"),
      apiKeyEnv: z.string().optional(),
    })
    .default({ provider: "duckduckgo" }),
  /** Per-tool overrides of the default risk-based policy. */
  toolPolicies: z.record(z.string(), ToolPolicy).default({}),
  maxSteps: z.number().int().positive().default(8),
});
export type JarvisConfig = z.infer<typeof JarvisConfig>;

export const CONFIG_DIR = process.env.JARVIS_HOME ?? join(homedir(), ".hey-jarvis");

export async function loadConfig(path = join(CONFIG_DIR, "config.json")): Promise<JarvisConfig> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return JarvisConfig.parse(raw);
}
