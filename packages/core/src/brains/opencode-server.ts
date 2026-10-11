/**
 * Launches a private `opencode serve` and makes sure it dies with Jarvis.
 *
 * Replaces the SDK's createOpencodeServer because that only sends SIGTERM to
 * the direct child, which `opencode serve` can outlive — leaving orphaned
 * servers behind on every restart.
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import spawn from "cross-spawn";

export interface OpencodeServer {
  url: string;
  pid: number;
  close(): Promise<void>;
}

const isWindows = process.platform === "win32";

/** Kill the process and everything it started. */
function killTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-proc.pid, signal); // the whole process group (spawned detached)
  } catch {
    proc.kill(signal);
  }
}

export async function startOpencodeServer(options: {
  port: number;
  config: object;
  timeoutMs?: number;
  bin?: string;
}): Promise<OpencodeServer> {
  const proc = spawn(options.bin ?? "opencode", ["serve", "--hostname=127.0.0.1", `--port=${options.port}`], {
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config) },
    detached: !isWindows, // own process group, so we can kill its children too
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Last resort: if the core exits without closing us, take the server down with it.
  const onExit = () => killTree(proc, "SIGKILL");
  process.once("exit", onExit);

  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      killTree(proc, "SIGKILL");
      reject(new Error(`OpenCode didn't start within ${options.timeoutMs ?? 30_000} ms.\n${output}`));
    }, options.timeoutMs ?? 30_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /opencode server listening on\s+(https?:\/\/\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`OpenCode exited with code ${code}.\n${output}`));
    });
  });
  // Keep draining output so the pipes never fill up and block the server.
  proc.stdout?.resume();
  proc.stderr?.resume();

  return {
    url,
    pid: proc.pid!,
    close: async () => {
      process.off("exit", onExit);
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      killTree(proc, "SIGTERM");
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000).unref());
      if ((await Promise.race([exited, timeout])) === "timeout") {
        killTree(proc, "SIGKILL");
        await exited;
      }
    },
  };
}
