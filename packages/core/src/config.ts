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
  /**
   * Which brain thinks: "opencode" (private OpenCode server, your OpenCode models and login),
   * "native" (Jarvis's own loop on `provider`), or "auto" (native if a provider is set, else OpenCode).
   */
  brain: z.enum(["auto", "opencode", "native"]).default("auto"),
  /** Model for the native loop (BYOK / Ollama / OpenCode Zen). */
  provider: ProviderConfig.optional(),
  opencode: z
    .object({
      /** An already-running `opencode serve` to detect (informational). */
      baseURL: z.string().url().default("http://localhost:4096"),
      /** Port for Jarvis's private OpenCode server; 0 picks a free one. */
      port: z.number().int().min(0).default(0),
      /** "provider/model", e.g. "anthropic/claude-sonnet-5-5". Unset → OpenCode's default model. */
      model: z.string().optional(),
      /** Folder OpenCode works in. Defaults to ~/.hey-jarvis/workspace (a small git repo, which streams best). */
      directory: z.string().optional(),
      /** Extra OpenCode config merged into the private server's config. */
      config: z.record(z.string(), z.unknown()).optional(),
    })
    .default({ baseURL: "http://localhost:4096", port: 0 }),
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

/** Where Jarvis keeps its config, models and workspace (override with JARVIS_HOME). */
export const jarvisHome = (): string => process.env.JARVIS_HOME ?? join(homedir(), ".hey-jarvis");

export async function loadConfig(path = join(jarvisHome(), "config.json")): Promise<JarvisConfig> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return JarvisConfig.parse(raw);
}
