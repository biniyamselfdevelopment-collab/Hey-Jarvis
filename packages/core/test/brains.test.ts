import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createModel, findOnPath } from "../src/brains/index.js";

describe("findOnPath", () => {
  it("finds executables on PATH and ignores missing ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-path-"));
    const bin = join(dir, "claude");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    expect(await findOnPath("claude", { PATH: dir }, "linux")).toBe(bin);
    expect(await findOnPath("codex", { PATH: dir }, "linux")).toBeNull();
  });
  it("tries PATHEXT extensions on Windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-path-"));
    await writeFile(join(dir, "opencode.cmd"), "");
    expect(await findOnPath("opencode", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(join(dir, "opencode.cmd"));
  });
});

describe("createModel", () => {
  it("builds models for presets and rejects unknown ones", () => {
    expect(createModel({ preset: "ollama", model: "qwen3:8b" })).toMatchObject({ modelId: "qwen3:8b" });
    expect(createModel({ preset: "anthropic", model: "claude-haiku-5-5" })).toMatchObject({ modelId: "claude-haiku-5-5" });
    expect(() => createModel({ preset: "mystery", model: "x" })).toThrow(/Unknown provider preset/);
  });
});
