import { describe, expect, it } from "vitest";

import { resolveAgentExecutable, resolveClaudeExecutable, resolveCodexExecutable } from "../resolve-claude";

const home = "C:\\Users\\me";
const env = { PATH: "C:\\Windows\\system32;C:\\Users\\me\\.local\\bin;C:\\Users\\me\\AppData\\Roaming\\npm" };

describe("resolve on Windows", () => {
  it("finds the native installer's claude.exe on PATH", () => {
    const exists = (p: string) => p === "C:\\Users\\me\\.local\\bin\\claude.exe";
    expect(resolveClaudeExecutable({ env, home, platform: "win32", isExecutable: exists })).toBe(
      "C:\\Users\\me\\.local\\bin\\claude.exe",
    );
  });

  it("finds claude.exe under ~/.local/bin even when PATH misses it", () => {
    const exists = (p: string) => p === "C:\\Users\\me\\.local\\bin\\claude.exe";
    expect(resolveClaudeExecutable({ env: {}, home, platform: "win32", isExecutable: exists })).toBe(
      "C:\\Users\\me\\.local\\bin\\claude.exe",
    );
  });

  it("finds npm's codex.cmd shim", () => {
    const exists = (p: string) => p === "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd";
    expect(resolveCodexExecutable({ env, home, platform: "win32", isExecutable: exists })).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
    );
  });

  it("keeps the bare name on macOS", () => {
    const exists = (p: string) => p === "/opt/homebrew/bin/claude";
    expect(resolveClaudeExecutable({ env: { PATH: "/usr/bin" }, home: "/Users/me", platform: "darwin", isExecutable: exists })).toBe(
      "/opt/homebrew/bin/claude",
    );
  });
});

describe("an ACP agent's binary", () => {
  it("honours LOTUS_<BINARY>_PATH, dashes as underscores", () => {
    const exists = (p: string) => p === "/opt/cursor";
    expect(resolveAgentExecutable("cursor-agent", { env: { LOTUS_CURSOR_AGENT_PATH: "/opt/cursor" }, isExecutable: exists })).toBe("/opt/cursor");
    expect(resolveAgentExecutable("agy", { env: { LOTUS_AGY_PATH: "/opt/cursor" }, isExecutable: exists })).toBe("/opt/cursor");
  });

  it("finds it in ~/.local/bin", () => {
    const exists = (p: string) => p === "/Users/me/.local/bin/cursor-agent";
    expect(resolveAgentExecutable("cursor-agent", { env: { PATH: "/usr/bin" }, home: "/Users/me", platform: "darwin", isExecutable: exists })).toBe(
      "/Users/me/.local/bin/cursor-agent",
    );
  });
});
