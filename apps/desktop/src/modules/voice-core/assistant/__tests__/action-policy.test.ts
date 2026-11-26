import { describe, expect, it } from "vitest";
import { classifyBrainAction, describeBrainAction, isReadOnlyCommand } from "../action-policy";

describe("isReadOnlyCommand", () => {
  it.each(["git status", "git log --oneline -5", "git diff HEAD~1", "ls -la", "cat README.md", "rg foo src", "git branch -a", "git remote -v"])(
    "lets %s run",
    (command) => expect(isReadOnlyCommand(command)).toBe(true),
  );

  it.each([
    "git push origin main",
    "git merge feature",
    "git branch new-feature",
    "git branch -D old",
    "git remote add origin x",
    "rm -rf build",
    "ls && rm x",
    "cat a > b",
    "echo $(whoami)",
    "find . -delete",
    "find . -exec rm {} ;",
    "rg --pre ./evil foo",
    "git diff --output=patch.txt",
    "",
  ])("asks before %s", (command) => expect(isReadOnlyCommand(command)).toBe(false));
});

describe("classifyBrainAction", () => {
  it("runs reads and read-only Lotus tools", () => {
    expect(classifyBrainAction("Read", { file_path: "/x" })).toBe("allow");
    expect(classifyBrainAction("mcp__lotus__lotus_list_fleet", {})).toBe("allow");
    expect(classifyBrainAction("mcp__lotus-dev__lotus_github_read", {})).toBe("allow");
    expect(classifyBrainAction("Bash", { command: "git status" })).toBe("allow");
  });

  it("runs a delegation only into a new worktree", () => {
    expect(classifyBrainAction("mcp__lotus__lotus_chat_delegate", { worktree: true, prompt: "fix" })).toBe("allow");
    expect(classifyBrainAction("mcp__lotus__lotus_chat_delegate", { prompt: "fix" })).toBe("ask");
  });

  it("asks before writes, sends, closes and unknown servers", () => {
    for (const tool of ["Edit", "Write", "mcp__lotus__lotus_dispatch_to_cell", "mcp__lotus__lotus_close_cell", "mcp__lotus__lotus_automation_create", "mcp__lotus__lotus_canvas_browser_click", "mcp__slack__send_message", "mcp__other__lotus_list_fleet"]) {
      expect(classifyBrainAction(tool, {})).toBe("ask");
    }
    expect(classifyBrainAction("Bash", { command: "git push" })).toBe("ask");
    expect(classifyBrainAction("Bash", {})).toBe("ask");
  });
});

describe("classifyBrainAction under each confirm mode", () => {
  it("risky only lets local work through and stops what leaves the machine", () => {
    expect(classifyBrainAction("Edit", { file_path: "/repo/a.ts" }, "auto")).toBe("allow");
    expect(classifyBrainAction("Bash", { command: "git commit -m wip" }, "auto")).toBe("allow");
    expect(classifyBrainAction("Bash", { command: "bun run test" }, "auto")).toBe("allow");
    expect(classifyBrainAction("Bash", { command: "git push origin main" }, "auto")).toBe("ask");
    expect(classifyBrainAction("Bash", { command: "rm -rf build" }, "auto")).toBe("ask");
    expect(classifyBrainAction("mcp__lotus__lotus_chat_tell", { text: "hi" }, "auto")).toBe("ask");
    expect(classifyBrainAction("mcp__other__anything", {}, "auto")).toBe("ask");
  });

  it("always asks for every change, and off asks for nothing", () => {
    expect(classifyBrainAction("Edit", { file_path: "/repo/a.ts" }, "always")).toBe("ask");
    expect(classifyBrainAction("Bash", { command: "git push" }, "off")).toBe("allow");
  });
});

describe("describeBrainAction", () => {
  it("names the action for the spoken question", () => {
    expect(describeBrainAction("Bash", { command: "git push origin main" })).toBe("push to origin main");
    expect(describeBrainAction("Bash", { command: "git push -f" })).toBe("force push your commits");
    expect(describeBrainAction("Bash", { command: 'git commit -m "wip"' })).toBe("commit the staged changes");
    expect(describeBrainAction("Bash", { command: "gh pr merge 42 --squash" })).toBe("merge pull request 42");
    // A chain is read out whole: naming only its first step would hide the rest.
    expect(describeBrainAction("Bash", { command: "git add a && git push" })).toBe("run the command git add a && git push");
    expect(describeBrainAction("Write", { file_path: "/repo/src/a.ts" })).toBe("write a.ts");
    expect(describeBrainAction("mcp__lotus__lotus_chat_tell", { text: "rebase please" })).toBe("chat tell: rebase please");
    expect(describeBrainAction("Unknown", {})).toBe("use Unknown");
  });
});
