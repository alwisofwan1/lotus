import { describe, expect, it } from "vitest";
import {
  firstPromptTitle,
  isAgentLaunchCommand,
  paneTitleRename,
  paneTitleSeed,
  paneTitleSource,
  planPaneTitle,
  titleIsWorthShortening,
  titleProviderForCommand,
  turnJustSettled,
} from "@/modules/workspace-shell/services/pane-title";

// A pane the seed may name: a terminal with an agent running in it.
const terminal = { type: "terminal" as const, agentCommand: "claude" };

describe("firstPromptTitle", () => {
  it("names the pane after what was asked", () => {
    expect(firstPromptTitle("fix the flaky login test")).toBe("Fix the flaky login test");
  });

  it("keeps the ask and drops the evidence pasted under it", () => {
    const prompt = "why does the build fail\n\nError: ENOENT\n  at Module._resolve";
    expect(firstPromptTitle(prompt)).toBe("Why does the build fail");
  });

  it("has nothing to say about an empty prompt", () => {
    expect(firstPromptTitle("   \n\n ")).toBeNull();
  });

  it("clamps a prompt too long to read in a rail row", () => {
    const title = firstPromptTitle("a".repeat(120));
    expect(title).toHaveLength(48);
    expect(title?.endsWith("…")).toBe(true);
  });
});

describe("titleIsWorthShortening", () => {
  it("leaves a short prompt alone — it is already its own title", () => {
    expect(titleIsWorthShortening("fix login")).toBe(false);
  });

  it("asks for a shorter name once there is something to shorten", () => {
    expect(titleIsWorthShortening("please fix the flaky login test in CI")).toBe(true);
  });
});

describe("paneTitleSeed", () => {
  const now = 1_700_000_000_000;

  it("names an unnamed terminal from its first prompt", () => {
    expect(paneTitleSeed({ cell: terminal, prompt: "review the diff", now })).toEqual({
      title: "Review the diff",
      status: "pending",
      updatedAt: now,
    });
  });

  it("never takes a name away: a second prompt changes nothing", () => {
    const cell = { ...terminal, title: "Review the diff", titleStatus: "pending" as const };
    expect(paneTitleSeed({ cell, prompt: "now deploy it", now })).toBeNull();
  });

  /*
    Seen in the rail 2026-10-09: "Dangerously skip permissions", "Bypass permissions on
    initech", "Running initech dangerously". The first thing typed into a fresh shell is the
    command that starts the agent, and the seed took it for the task.
  */
  it("does not name a pane after the command that launched its agent", () => {
    for (const prompt of [
      "claude --dangerously-skip-permissions",
      "ccs initech --dangerously-skip-permissions",
      "codex",
      "CLAUDE_CONFIG_DIR=~/.x claude",
      "/usr/local/bin/claude -c",
    ]) {
      expect(paneTitleSeed({ cell: terminal, prompt, now })).toBeNull();
    }
  });

  it("does not name a plain shell after a shell command", () => {
    const shell = { type: "terminal" as const };
    expect(paneTitleSeed({ cell: shell, prompt: "bun run tauri:dev", now })).toBeNull();
  });

  it("names a pane whose agent was detected from its output", () => {
    const detected = { type: "terminal" as const, runtimeProvider: "claude" as const };
    expect(paneTitleSeed({ cell: detected, prompt: "review the diff", now })?.title).toBe("Review the diff");
  });

  it("leaves panes that are not terminals to whoever owns their name", () => {
    const cell = { type: "browser" as const };
    expect(paneTitleSeed({ cell, prompt: "review the diff", now })).toBeNull();
  });
});

describe("isAgentLaunchCommand", () => {
  it("knows an agent launch from a task", () => {
    expect(isAgentLaunchCommand("claude")).toBe(true);
    expect(isAgentLaunchCommand("cccs work -c")).toBe(true);
    expect(isAgentLaunchCommand("cursor-agent --resume")).toBe(true);
    expect(isAgentLaunchCommand("claude, fix the login test")).toBe(false);
    expect(isAgentLaunchCommand("fix the claude integration")).toBe(false);
  });
});

describe("turnJustSettled", () => {
  it("is the moment a working pane stops", () => {
    expect(turnJustSettled("working", "idle")).toBe(true);
    expect(turnJustSettled("working", "needs-you")).toBe(true);
    expect(turnJustSettled("working", "working")).toBe(false);
    expect(turnJustSettled("starting", "idle")).toBe(false);
    expect(turnJustSettled(undefined, "idle")).toBe(false);
  });
});

describe("planPaneTitle", () => {
  const now = 1_700_000_000_000;
  const key = "/u/.claude/projects/-x/s1.jsonl";
  const base = {
    cell: { type: "terminal" as const, agentCommand: "claude", cwd: "/u/Lotus" },
    agent: { sessionKey: key, title: "Fitur auto title codeshare", hasPrompt: true },
    generatedKeys: new Set<string>(),
    enabled: true,
    now,
  };

  it("takes the agent's own title, free, and records which conversation it names", () => {
    expect(planPaneTitle(base)).toEqual({
      kind: "apply",
      patch: { title: "Fitur auto title codeshare", status: "ready", updatedAt: now, sessionKey: key },
    });
  });

  it("does nothing when the pane already carries that title for that conversation", () => {
    const cell = { ...base.cell, title: "Fitur auto title codeshare", titleStatus: "ready" as const, titleSessionKey: key };
    expect(planPaneTitle({ ...base, cell })).toEqual({ kind: "none" });
  });

  /*
    The screenshot of 2026-10-10: pane Zia read "Pane rendering and activity logs", a title made
    on 9 Oct, while the claude running in it had named its own, newer conversation "Fitur auto
    title codeshare". The seed refused (the pane had a name) and the refine refused (it was
    `ready`), so the old name could never leave.
  */
  it("replaces a title from an earlier conversation in the same pane", () => {
    const cell = { ...base.cell, title: "Pane rendering and activity logs", titleStatus: "ready" as const, titleSessionKey: "/old.jsonl" };
    expect(planPaneTitle({ ...base, cell })).toMatchObject({ kind: "apply", patch: { title: "Fitur auto title codeshare", sessionKey: key } });
  });

  it("replaces a title stored before titles knew their conversation", () => {
    const cell = { ...base.cell, title: "Starting Voice Core 03", titleStatus: "ready" as const };
    expect(planPaneTitle({ ...base, cell })).toMatchObject({ kind: "apply", patch: { title: "Fitur auto title codeshare" } });
  });

  it("keeps a title typed in the title control, whatever the agent says", () => {
    const cell = { ...base.cell, title: "My name", titleStatus: "manual" as const };
    expect(planPaneTitle({ ...base, cell })).toEqual({ kind: "none" });
  });

  it("does not let a later agent title undo a Regenerate of the same conversation", () => {
    const cell = { ...base.cell, title: "Regenerated name", titleStatus: "ready" as const, titleSessionKey: key };
    expect(planPaneTitle({ ...base, cell })).toEqual({ kind: "none" });
  });

  it("leaves the seeded title alone when no transcript is known", () => {
    expect(planPaneTitle({ ...base, agent: null })).toEqual({ kind: "none" });
  });

  it("obeys the setting", () => {
    expect(planPaneTitle({ ...base, enabled: false })).toEqual({ kind: "none" });
  });

  it("asks a model when the agent's title names no task", () => {
    const agent = { ...base.agent, title: "Mulai kerjakan sekarang" };
    expect(planPaneTitle({ ...base, agent })).toMatchObject({ kind: "generate" });
  });

  it("ignores an agent title that only repeats the folder", () => {
    const agent = { ...base.agent, title: "Lotus" };
    expect(planPaneTitle({ ...base, agent })).toMatchObject({ kind: "generate" });
  });

  describe("when the agent wrote no title", () => {
    const agent = { sessionKey: key, hasPrompt: true };

    it("asks a model once per conversation", () => {
      expect(planPaneTitle({ ...base, agent })).toEqual({ kind: "generate", sessionKey: key, clearStale: false });
      expect(planPaneTitle({ ...base, agent, generatedKeys: new Set([key]) })).toEqual({ kind: "none" });
    });

    it("clears a stale title from another conversation while it asks", () => {
      const cell = { ...base.cell, title: "Old task", titleStatus: "ready" as const, titleSessionKey: "/old.jsonl" };
      expect(planPaneTitle({ ...base, cell, agent })).toEqual({ kind: "generate", sessionKey: key, clearStale: true });
    });

    it("keeps a title already made for this conversation", () => {
      const cell = { ...base.cell, title: "Fix login", titleStatus: "ready" as const, titleSessionKey: key };
      expect(planPaneTitle({ ...base, cell, agent })).toEqual({ kind: "none" });
    });

    it("settles a seeded title too short to shorten instead of spending a call", () => {
      const cell = { ...base.cell, title: "Fix login", titleStatus: "pending" as const };
      expect(planPaneTitle({ ...base, cell, agent })).toEqual({
        kind: "apply",
        patch: { title: "Fix login", status: "ready", updatedAt: now, sessionKey: key },
      });
    });

    it("waits for a prompt before asking", () => {
      expect(planPaneTitle({ ...base, agent: { sessionKey: key, hasPrompt: false } })).toEqual({ kind: "none" });
    });

    it("drops a stale title even before the new conversation has a prompt", () => {
      const cell = { ...base.cell, title: "Old task", titleStatus: "ready" as const, titleSessionKey: "/old.jsonl" };
      expect(planPaneTitle({ ...base, cell, agent: { sessionKey: key, hasPrompt: false } })).toEqual({
        kind: "apply",
        patch: { title: null, status: null, updatedAt: now, sessionKey: key },
      });
    });
  });
});

describe("titleProviderForCommand", () => {
  it("titles a pane with its own CLI family", () => {
    expect(titleProviderForCommand("codex")).toBe("codex");
    expect(titleProviderForCommand("claude --dangerously-skip-permissions")).toBe("claude");
  });

  it("falls back for a family with no one-shot mode this app drives", () => {
    expect(titleProviderForCommand("cursor-agent")).toBe("claude");
    expect(titleProviderForCommand(null)).toBe("claude");
  });
});


describe("paneTitleSource", () => {
  it("says where a title came from", () => {
    expect(paneTitleSource({ title: "" })).toBeUndefined();
    expect(paneTitleSource({ title: "Fix login", titleStatus: "pending" })).toBe("prompt");
    expect(paneTitleSource({ title: "Fix login", titleStatus: "ready" })).toBe("auto");
    expect(paneTitleSource({ title: "Fix login", titleStatus: "manual" })).toBe("manual");
  });
});

describe("paneTitleRename", () => {
  it("keeps a typed title as manual, and hands an empty one back to automatic", () => {
    expect(paneTitleRename("Mine", 1)).toEqual({ title: "Mine", status: "manual", updatedAt: 1 });
    expect(paneTitleRename("", 1)).toEqual({ title: null, status: null, updatedAt: 1, sessionKey: null });
  });
});
