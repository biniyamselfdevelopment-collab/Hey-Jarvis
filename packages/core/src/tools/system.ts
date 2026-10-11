import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.js";

/** Launch something with the OS's default handler without waiting for it. */
function launch(target: string): Promise<void> {
  const isUrl = target.includes("://");
  let cmd: string;
  let args: string[];
  if (process.platform === "win32") [cmd, args] = ["cmd", ["/c", "start", "", target]];
  else if (process.platform === "darwin") [cmd, args] = ["open", isUrl ? [target] : ["-a", target]];
  // TODO(M2): resolve app names to .desktop entries; xdg-open only handles URLs/files.
  else [cmd, args] = isUrl ? ["xdg-open", [target]] : [target.toLowerCase(), []];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function runShell(command: string, signal: AbortSignal, timeoutMs = 60_000) {
  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL ?? "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command];
  return new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
    const child = spawn(shell, args, { signal, timeout: timeoutMs });
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length < 20_000) output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, output: output.slice(0, 20_000) }));
  });
}

export function systemTools() {
  const openApp = defineTool({
    name: "open_app",
    description: "Open an application by name (e.g. 'Spotify', 'notepad', 'Visual Studio Code').",
    risk: "medium",
    input: z.object({ name: z.string().min(1) }),
    describe: ({ name }) => `Open ${name}.`,
    async run({ name }) {
      await launch(name);
      return { opened: name };
    },
  });

  const openUrl = defineTool({
    name: "open_url",
    description: "Open a URL in the user's default browser.",
    risk: "medium",
    input: z.object({ url: z.string().url() }),
    describe: ({ url }) => `Open ${new URL(url).hostname} in your browser.`,
    async run({ url }) {
      await launch(url);
      return { opened: url };
    },
  });

  const shell = defineTool({
    name: "run_shell",
    description:
      "Run a shell command (PowerShell on Windows, the user's shell elsewhere) and return its output. Use for system tasks no other tool covers.",
    risk: "high",
    input: z.object({ command: z.string().min(1), reason: z.string().describe("Why, in a few words, for the confirmation") }),
    describe: ({ command, reason }) => `I'd like to run a command to ${reason}: ${command}.`,
    run: ({ command }, { signal }) => runShell(command, signal),
  });

  return [openApp, openUrl, shell];
}
