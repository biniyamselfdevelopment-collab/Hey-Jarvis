import type { z } from "zod";
import type { Risk } from "../permissions.js";

export interface ToolContext {
  signal: AbortSignal;
  /** Narrate progress for slow tools ("Claude is running the tests…"). */
  progress: (detail: string) => void;
  /** Run a native tool in the Rust host (screenshot, click, keychain…). */
  callHost: (name: string, args: unknown) => Promise<unknown>;
}

export interface JarvisTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  risk: Risk;
  input: S;
  /** One spoken sentence describing exactly what will happen; used for confirmations. */
  describe: (input: z.infer<S>) => string;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: JarvisTool<S>): JarvisTool<S> {
  return tool;
}
