import { describe, expect, it } from "vitest";
import { buildOpencodeConfig, describePermission } from "../src/brains/opencode.js";
import { JarvisConfig } from "../src/config.js";

describe("describePermission", () => {
  it("explains bash commands with their purpose", () => {
    expect(describePermission({ permission: "bash", patterns: ["git status"], metadata: { command: "git status", description: "Show repo status." } })).toEqual({
      summary: "I'd like to run a command to show repo status.",
      detail: "git status",
    });
  });
  it("names the file for edits", () => {
    expect(describePermission({ permission: "edit", patterns: ["C:/Users/me/notes.txt"], metadata: {} }).summary).toBe(
      "I'd like to change notes.txt.",
    );
  });
  it("has a generic fallback", () => {
    expect(describePermission({ permission: "external_api", patterns: [], metadata: {} }).summary).toBe(
      "OpenCode wants permission to use external api.",
    );
  });
});

describe("buildOpencodeConfig", () => {
  const mcp = { url: "http://127.0.0.1:1234/mcp", token: "t" };

  it("injects the jarvis agent and MCP server with voice-safe permissions", () => {
    const cfg = buildOpencodeConfig(JarvisConfig.parse({ opencode: { model: "anthropic/claude-sonnet-5-5" } }), mcp);
    expect(cfg.mcp?.jarvis).toEqual({ type: "remote", url: mcp.url, headers: { Authorization: "Bearer t" }, oauth: false, enabled: true });
    const agent = cfg.agent?.jarvis;
    expect(agent?.model).toBe("anthropic/claude-sonnet-5-5");
    expect(agent?.permission).toMatchObject({ bash: "ask", edit: "ask", question: "deny", webfetch: "allow" });
    expect(agent?.prompt).toContain("friendly helper");
  });

  it("lets toolPolicies relax or tighten OpenCode permissions, and merges extra config", () => {
    const cfg = buildOpencodeConfig(
      JarvisConfig.parse({ toolPolicies: { bash: "allow", webfetch: "deny" }, opencode: { config: { mcp: { other: { type: "local", command: ["x"] } } } } }),
      mcp,
    );
    expect(cfg.agent?.jarvis?.permission).toMatchObject({ bash: "allow", webfetch: "deny" });
    expect(Object.keys(cfg.mcp ?? {})).toEqual(["other", "jarvis"]);
  });
});
