import { describe, expect, it, vi } from "vitest";
import { agentLaunchCommand, claudeResumeCommand, cycleAccount, claudeSessionIdFromTranscript, loadShellAgents, orderShellAgents, withClaudeAccounts } from "../agent-catalog";
import type { AccountView, DetectedCli } from "@/lib/tauri-api";

const cli = (id: string, command: string, installed: boolean): DetectedCli => ({
  id,
  name: id,
  command,
  path: installed ? `/usr/local/bin/${id}` : null,
  installed,
});

describe("the shell's agent catalog", () => {
  it("keeps the machine's answer, flags and all — it writes no command of its own", () => {
    const agents = orderShellAgents([cli("claude", "claude --dangerously-skip-permissions", true)]);
    expect(agentLaunchCommand(agents[0])).toBe("claude --dangerously-skip-permissions");
  });

  it("puts what is installed first, and keeps Rust's order within each half", () => {
    const agents = orderShellAgents([
      cli("gemini", "gemini", false),
      cli("claude", "claude --dangerously-skip-permissions", true),
      cli("droid", "droid", false),
      cli("codex", "codex --dangerously-bypass-approvals-and-sandbox", true),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["claude", "codex", "gemini", "droid"]);
  });

  it("still lists what is not installed, because that is a different problem from not knowing it", () => {
    const agents = orderShellAgents([cli("grok", "grok", false)]);
    expect(agents).toHaveLength(1);
    expect(agents[0].installed).toBe(false);
    expect(agents[0].path).toBeNull();
  });

  it("treats an empty machine as a state to draw, not an error", async () => {
    const detect = vi.fn(async () => []);
    await expect(loadShellAgents(detect)).resolves.toEqual([]);
    expect(detect).toHaveBeenCalledOnce();
  });
});

describe("Claude on an account (issues/07)", () => {
  const account = (id: string, signedIn: boolean): AccountView => ({
    id,
    source: id === "default" ? "default" : "lotus",
    dir: `/a/${id}`,
    identity: signedIn ? { email: `${id}@x`, org: null } : null,
    inUse: false,
    loginCommand: "",
  });

  it("adds one Claude row per signed-in non-default account, right after Claude, same command", () => {
    const agents = orderShellAgents([cli("claude", "claude --x", true), cli("codex", "codex", true)]);
    const rows = withClaudeAccounts(agents, [account("default", true), account("hss", true), account("new", false)]);
    expect(rows.map((r) => [r.id, r.name, r.command, r.claudeAccount])).toEqual([
      ["claude", "claude", "claude --x", undefined],
      ["claude@hss", "claude · hss", "claude --x", "hss"],
      ["codex", "codex", "codex", undefined],
    ]);
  });

  it("offers no account row when Claude is not installed", () => {
    const rows = withClaudeAccounts(orderShellAgents([cli("claude", "claude", false)]), [account("hss", true)]);
    expect(rows.map((r) => r.id)).toEqual(["claude"]);
  });
});

describe("moving a Claude pane to another account", () => {
  it("resumes one conversation, never stacking an earlier one", () => {
    const base = "claude --dangerously-skip-permissions";
    expect(claudeResumeCommand(base, "4f1c")).toBe(`${base} --resume 4f1c`);
    expect(claudeResumeCommand(`${base} --resume 4f1c`, "9a2b")).toBe(`${base} --resume 9a2b`);
    expect(claudeResumeCommand(`claude -r=old --continue -c --model opus`, null)).toBe("claude --model opus");
    // A bare `--resume` (the picker) goes too; the next flag is not its value.
    expect(claudeResumeCommand(`claude --resume --model opus`, "x")).toBe("claude --model opus --resume x");
  });

  it("reads the session id off a transcript path", () => {
    expect(claudeSessionIdFromTranscript("/h/.claude/projects/-repo/4f1c-aa.jsonl")).toBe("4f1c-aa");
    expect(claudeSessionIdFromTranscript(undefined)).toBeNull();
    expect(claudeSessionIdFromTranscript("/h/x.json")).toBeNull();
  });
});

describe("cycleAccount", () => {
  it("steps default → each account → default", () => {
    expect(cycleAccount(["a", "b"], null)).toBe("a");
    expect(cycleAccount(["a", "b"], "a")).toBe("b");
    expect(cycleAccount(["a", "b"], "b")).toBeNull();
    expect(cycleAccount(["a"], "gone")).toBeNull();
  });
});
