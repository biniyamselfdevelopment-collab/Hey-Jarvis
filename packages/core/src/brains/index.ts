/**
 * Brain discovery, the Open Design way: detect what the user already has
 * (OpenCode server, coding-agent CLIs on PATH, BYOK keys) and let them pick.
 */
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { JarvisConfig, ProviderConfig } from "../config.js";
import type { BrainSummary } from "../protocol.js";

/** OpenAI-compatible endpoints that work out of the box. */
export const PRESET_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  "opencode-zen": "https://opencode.ai/zen/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
};

/** Coding-agent CLIs Jarvis can delegate to. */
export const KNOWN_AGENT_CLIS: Record<string, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  "cursor-agent": "Cursor Agent",
  copilot: "GitHub Copilot CLI",
  qwen: "Qwen Code",
  aider: "Aider",
};

export function createModel(p: ProviderConfig): LanguageModel {
  const apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
  if (p.preset === "anthropic") {
    return createAnthropic({ apiKey, ...(p.baseURL ? { baseURL: p.baseURL } : {}) })(p.model);
  }
  const baseURL = p.baseURL ?? PRESET_BASE_URLS[p.preset];
  if (!baseURL) throw new Error(`Unknown provider preset "${p.preset}" — set baseURL for custom endpoints.`);
  return createOpenAICompatible({ name: p.preset, baseURL, apiKey })(p.model);
}

export async function findOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext.toLowerCase());
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export async function isOpencodeServerUp(baseURL: string, timeoutMs = 800): Promise<boolean> {
  try {
    // `opencode serve` publishes its OpenAPI document at /doc.
    const res = await fetch(new URL("/doc", baseURL), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function detectBrains(config: JarvisConfig): Promise<BrainSummary[]> {
  const [opencodeUp, clis] = await Promise.all([
    isOpencodeServerUp(config.opencode.baseURL),
    Promise.all(Object.entries(KNOWN_AGENT_CLIS).map(async ([bin, label]) => ({ bin, label, path: await findOnPath(bin) }))),
  ]);

  const brains: BrainSummary[] = [];
  if (config.provider) {
    brains.push({
      id: `byok:${config.provider.preset}`,
      kind: "byok",
      label: `${config.provider.preset} · ${config.provider.model}`,
      available: true,
    });
  }
  brains.push({ id: "opencode-server", kind: "opencode", label: `OpenCode server (${config.opencode.baseURL})`, available: opencodeUp });
  for (const c of clis) brains.push({ id: `cli:${c.bin}`, kind: "cli", label: c.label, available: c.path !== null });
  return brains;
}
