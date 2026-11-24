import { describe, expect, it } from "vitest";
import { dropAgentLaunch } from "../useCodeSpaceWorkspaceManager";
import type { TerminalCellData } from "@/modules/codespace/components/types";

const agent: TerminalCellData = {
  id: "p1",
  type: "terminal",
  cwd: "/repo",
  agentCommand: "claude",
  terminalCommand: ["claude", "--append-system-prompt", "x"],
  runtimeProvider: "claude",
  claudeAccount: "acme",
  agentName: "Gio",
  title: "Sapaan dan tawaran bantuan",
  titleStatus: "ready",
  titleSessionKey: "/t.jsonl",
} as TerminalCellData;

describe("dropAgentLaunch (an agent exited: the pane becomes a shell)", () => {
  it("clears the launch, the provider and the conversation's title, keeping the pane itself", () => {
    const shell = dropAgentLaunch(agent);
    expect(shell.agentCommand).toBeUndefined();
    expect(shell.terminalCommand).toBeUndefined();
    expect(shell.runtimeProvider).toBeUndefined();
    expect(shell.title).toBeUndefined();
    expect(shell.titleSessionKey).toBeUndefined();
    expect(shell).toMatchObject({ id: "p1", cwd: "/repo", agentName: "Gio", claudeAccount: "acme" });
  });

  it("keeps a title the user typed", () => {
    const shell = dropAgentLaunch({ ...agent, title: "Mine", titleStatus: "manual" });
    expect(shell).toMatchObject({ title: "Mine", titleStatus: "manual" });
  });
});
