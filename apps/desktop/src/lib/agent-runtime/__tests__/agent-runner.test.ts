import { describe, expect, it } from "vitest";
import {
  applyRunnerSessionTemplate,
  isClaudeFamilyRunner,
  runnerCanResume,
  resolveRunnerCommand,
  runnerSupportsPreMintedSession,
  runnerSupportsResume,
} from "../agent-runner";

describe("isClaudeFamilyRunner", () => {
  it("treats claude, ccs, and csp as claude-family", () => {
    expect(isClaudeFamilyRunner("claude")).toBe(true);
    expect(isClaudeFamilyRunner("ccs")).toBe(true);
    expect(isClaudeFamilyRunner("csp")).toBe(true);
  });

  it("treats codex and cursor as non-family", () => {
    expect(isClaudeFamilyRunner("codex")).toBe(false);
    expect(isClaudeFamilyRunner("cursor")).toBe(false);
  });

  it("treats a plain custom runner as non-family", () => {
    expect(isClaudeFamilyRunner("custom")).toBe(false);
  });

  it("promotes a custom runner to claude-family when the registry flag is set (a Claude account wrapper)", () => {
    expect(isClaudeFamilyRunner("custom", true)).toBe(true);
  });

  it("defaults an undefined runner to claude (claude-family)", () => {
    expect(isClaudeFamilyRunner(undefined)).toBe(true);
  });

  it("ignores the override for a runner that is already family (stays true)", () => {
    expect(isClaudeFamilyRunner("claude", false)).toBe(true);
  });
});

describe("resolveRunnerCommand", () => {
  it("claude → dangerously-skip-permissions", () => {
    expect(resolveRunnerCommand("claude")).toBe("claude --dangerously-skip-permissions");
  });

  it("ccs → claude profile ccs with YOLO flag", () => {
    expect(resolveRunnerCommand("ccs")).toBe("claude --profile ccs --dangerously-skip-permissions");
  });

  it("csp → claude profile csp with YOLO flag", () => {
    expect(resolveRunnerCommand("csp")).toBe("claude --profile csp --dangerously-skip-permissions");
  });

  it("codex → dangerously-bypass-approvals-and-sandbox", () => {
    expect(resolveRunnerCommand("codex")).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });

  it("custom with command → returns the command as-is", () => {
    expect(resolveRunnerCommand("custom", "my-agent --yolo")).toBe("my-agent --yolo");
  });

  it("custom without command → throws", () => {
    expect(() => resolveRunnerCommand("custom")).toThrow("custom runner requires a command");
  });

  it("safe permission mode removes autonomous write flags from built-ins", () => {
    expect(resolveRunnerCommand("claude", undefined, "safe")).toBe("claude");
    expect(resolveRunnerCommand("ccs", undefined, "safe")).toBe("claude --profile ccs");
    expect(resolveRunnerCommand("codex", undefined, "safe")).toBe("codex");
  });

  it("cursor → cursor-agent --yolo (full), bare in safe mode (ADR-0027)", () => {
    expect(resolveRunnerCommand("cursor")).toBe("cursor-agent --yolo");
    expect(resolveRunnerCommand("cursor", undefined, "safe")).toBe("cursor-agent");
  });

  it("appends extra flags from the Runner Registry (ADR-0027)", () => {
    expect(resolveRunnerCommand("claude", undefined, "full", "--model opus")).toBe(
      "claude --dangerously-skip-permissions --model opus",
    );
    expect(resolveRunnerCommand("cursor", undefined, "full", "--print")).toBe("cursor-agent --yolo --print");
    expect(resolveRunnerCommand("custom", "my-agent", "full", "--flag")).toBe("my-agent --flag");
  });

  it("ignores blank/whitespace extra flags", () => {
    expect(resolveRunnerCommand("claude", undefined, "full", "   ")).toBe("claude --dangerously-skip-permissions");
    expect(resolveRunnerCommand("codex", undefined, "full", undefined)).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });

  // ── Resume-on-reopen (ADR-0027 Phase 5) ───────────────────────────────────

  it("claude family appends the resume flag before extra flags (default mode)", () => {
    expect(resolveRunnerCommand("claude", undefined, "full", undefined, "sess-123")).toBe(
      "claude --dangerously-skip-permissions --resume sess-123",
    );
    expect(resolveRunnerCommand("ccs", undefined, "full", "--model opus", "sess-9")).toBe(
      "claude --profile ccs --dangerously-skip-permissions --resume sess-9 --model opus",
    );
    expect(resolveRunnerCommand("csp", undefined, "safe", undefined, "abc")).toBe(
      "claude --profile csp --resume abc",
    );
  });

  it("claude family pins a fresh session via --session-id in 'new' mode (ADR-0027 Phase 5)", () => {
    expect(resolveRunnerCommand("claude", undefined, "full", undefined, "uuid-1", "new")).toBe(
      "claude --dangerously-skip-permissions --session-id uuid-1",
    );
    expect(resolveRunnerCommand("ccs", undefined, "full", "--model opus", "uuid-2", "new")).toBe(
      "claude --profile ccs --dangerously-skip-permissions --session-id uuid-2 --model opus",
    );
  });

  // Was "does not fabricate a session flag for runners without verified support": codex and cursor
  // were unsupported because a flag table could not express `codex resume <id>`, and because cursor
  // had never been probed. Both were probed against the installed CLIs on 2026-09-06 and now have
  // real shapes, so what remains unfabricated is the mode a runner genuinely lacks.
  it("does not fabricate a session form a runner does not have", () => {
    // Codex mints its own id: there is no flag to start a session under one we chose.
    expect(resolveRunnerCommand("codex", undefined, "full", undefined, "sess-1", "new")).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox",
    );
    // Same for cursor — it can continue a chat, not be handed an id up front.
    expect(resolveRunnerCommand("cursor", undefined, "full", undefined, "sess-1", "new")).toBe("cursor-agent --yolo");
    // A custom runner's command is opaque here; its descriptor belongs to the Runner Registry.
    expect(resolveRunnerCommand("custom", "grok", "full", undefined, "sess-1")).toBe("grok");
  });

  it("ignores blank/whitespace resume ids", () => {
    expect(resolveRunnerCommand("claude", undefined, "full", undefined, "   ")).toBe(
      "claude --dangerously-skip-permissions",
    );
  });

  it("runnerSupportsResume reflects which runners can relaunch a session", () => {
    expect(runnerSupportsResume("claude")).toBe(true);
    expect(runnerSupportsResume("ccs")).toBe(true);
    expect(runnerSupportsResume("csp")).toBe(true);
    // Probed 2026-09-06: `codex resume <id>` and `cursor-agent --resume [chatId]` both exist.
    expect(runnerSupportsResume("codex")).toBe(true);
    expect(runnerSupportsResume("cursor")).toBe(true);
    // grok and opencode can resume too, but they arrive as `custom`, which this table cannot tell
    // apart — their descriptor belongs on the Runner Registry entry.
    expect(runnerSupportsResume("custom")).toBe(false);
  });
});

/**
 * The phone's permission scale, landing on the command that actually runs.
 *
 * Until 2026-08-27 this function knew two postures, so the summon sheet could only ever offer
 * two — a stop like `accept edits` was folded into `full` on the way through the canvas bridge
 * and reached `claude` as `--dangerously-skip-permissions`, which is not a near miss but the
 * opposite of what was chosen. These tests pin each stop to its flags.
 */
describe("resolveRunnerCommand · permission scale", () => {
  it("gives claude the CLI's own flag for the stops that have one", () => {
    expect(resolveRunnerCommand("claude", undefined, "plan")).toBe("claude --permission-mode plan");
    expect(resolveRunnerCommand("claude", undefined, "acceptEdits")).toBe(
      "claude --permission-mode acceptEdits",
    );
  });

  /**
   * Bare `claude` already asks per action, so the asking stop adds nothing. Both names for it
   * must resolve identically — `safe` is what every caller before the scale says, `manual` is
   * what the CLI and the phone now say.
   */
  it("resolves safe and manual to the same bare command", () => {
    expect(resolveRunnerCommand("claude", undefined, "manual")).toBe("claude");
    expect(resolveRunnerCommand("claude", undefined, "manual")).toBe(
      resolveRunnerCommand("claude", undefined, "safe"),
    );
  });

  it("carries the scale into the profile wrappers too", () => {
    expect(resolveRunnerCommand("ccs", undefined, "plan")).toBe(
      "claude --profile ccs --permission-mode plan",
    );
  });

  /** Codex has no `--permission-mode`; each stop is a sandbox and an approval policy. */
  it("expands codex stops into both of its axes", () => {
    expect(resolveRunnerCommand("codex", undefined, "read-only")).toBe(
      "codex --sandbox read-only --ask-for-approval on-request",
    );
    expect(resolveRunnerCommand("codex", undefined, "auto")).toBe(
      "codex --sandbox workspace-write --ask-for-approval on-request",
    );
  });

  /**
   * **An unrecognised stop resolves gated, never ungated** — and it took a 500 on a real phone
   * to see why this matters (2026-08-27). The set of stops belongs to the host that advertises
   * them, so a newer phone can send a word this build has never read; resolving that to
   * `--dangerously-skip-permissions` would hand out *more* freedom than anyone asked for, on
   * the one choice a running cell cannot be talked out of (ADR-8).
   *
   * An agent that asks too often is a nuisance. One that asks nothing cannot be called back.
   */
  it("reads an unknown stop as gated, not as the ungated default", () => {
    expect(resolveRunnerCommand("claude", undefined, "dontAsk")).toBe("claude");
    expect(resolveRunnerCommand("codex", undefined, "made-up")).toBe("codex");
  });

  /**
   * The three words that mean *the gate is off* are spelled out per runner rather than left to
   * a fallback, so the safe direction above is a property of the table rather than of luck:
   * `full` is the canvas', `yolo` the phone's legacy one, and the third is the CLI's own.
   */
  it("still lets every word for ungated through, on both runners", () => {
    const claudeFree = "claude --dangerously-skip-permissions";
    for (const mode of ["full", "yolo", "bypassPermissions"]) {
      expect(resolveRunnerCommand("claude", undefined, mode), mode).toBe(claudeFree);
    }
    const codexFree = "codex --dangerously-bypass-approvals-and-sandbox";
    for (const mode of ["full", "yolo", "full-access"]) {
      expect(resolveRunnerCommand("codex", undefined, mode), mode).toBe(codexFree);
    }
    // And the argument's own default, which every caller before the scale relied on.
    expect(resolveRunnerCommand("claude")).toBe(claudeFree);
  });

  it("still appends session and extra flags after the posture", () => {
    expect(resolveRunnerCommand("claude", undefined, "plan", "--verbose", "s-1", "new")).toBe(
      "claude --permission-mode plan --session-id s-1 --verbose",
    );
  });
});

// ── Session shapes (plans/codecanvas-session-widget/, Slice 06) ──────────────────────────────────

describe("runner session shapes", () => {
  it("continues a claude conversation with a resume flag", () => {
    expect(resolveRunnerCommand("claude", undefined, "safe", undefined, "sess-1")).toContain(
      "--resume sess-1",
    );
  });

  it("pre-mints a claude session when asked to start one under a chosen id", () => {
    expect(resolveRunnerCommand("claude", undefined, "safe", undefined, "sess-1", "new")).toContain(
      "--session-id sess-1",
    );
  });

  // `codex resume [OPTIONS] [SESSION_ID]` — a subcommand, which a flag table could never express.
  // The id trails the options because that is where codex's own usage line puts it.
  it("continues a codex conversation with its resume subcommand, id last", () => {
    const command = resolveRunnerCommand("codex", undefined, "safe", undefined, "sess-1");
    expect(command).toBe("codex resume sess-1");
  });

  it("keeps codex posture flags between the subcommand and the id", () => {
    const command = resolveRunnerCommand("codex", undefined, "read-only", undefined, "sess-1");
    expect(command).toBe("codex resume --sandbox read-only --ask-for-approval on-request sess-1");
  });

  it("leaves codex alone when there is no session to continue", () => {
    expect(resolveRunnerCommand("codex", undefined, "safe")).toBe("codex");
  });

  // Codex mints its own id; asking for a "new" session under our id would be a flag it does not have.
  it("does not try to pre-mint a codex session", () => {
    expect(resolveRunnerCommand("codex", undefined, "safe", undefined, "sess-1", "new")).toBe("codex");
    expect(runnerSupportsPreMintedSession("codex")).toBe(false);
  });

  it("continues a cursor conversation with a resume flag", () => {
    expect(resolveRunnerCommand("cursor", undefined, "safe", undefined, "chat-1")).toContain(
      "--resume chat-1",
    );
  });

  it("knows which runners can continue a conversation at all", () => {
    expect(runnerSupportsResume("claude")).toBe(true);
    expect(runnerSupportsResume("ccs")).toBe(true);
    expect(runnerSupportsResume("codex")).toBe(true);
    expect(runnerSupportsResume("cursor")).toBe(true);
    // grok and opencode can too, but they arrive as `custom` — which this table cannot tell apart.
    expect(runnerSupportsResume("custom")).toBe(false);
  });

  it("knows that only a pre-mint-capable runner may be handed an id in advance", () => {
    expect(runnerSupportsPreMintedSession("claude")).toBe(true);
    expect(runnerSupportsPreMintedSession("cursor")).toBe(false);
  });
});

describe("custom runner session templates", () => {
  it("fills the id into a runner's own template", () => {
    expect(applyRunnerSessionTemplate("--resume {id}", "sess-1")).toBe("--resume sess-1");
    expect(applyRunnerSessionTemplate("--session {id}", "ses_abc")).toBe("--session ses_abc");
  });

  it("contributes nothing without a template or an id", () => {
    expect(applyRunnerSessionTemplate(undefined, "sess-1")).toBe("");
    expect(applyRunnerSessionTemplate("--resume {id}", "")).toBe("");
    expect(applyRunnerSessionTemplate("--resume {id}", "   ")).toBe("");
    expect(applyRunnerSessionTemplate(null, null)).toBe("");
  });

  // A template with no placeholder would otherwise append an id nobody asked for, in a position the
  // runner never agreed to.
  it("refuses a template that does not say where the id goes", () => {
    expect(applyRunnerSessionTemplate("--resume", "sess-1")).toBe("");
  });

  it("knows a custom runner can resume once it declares how", () => {
    expect(runnerCanResume("custom")).toBe(false);
    expect(runnerCanResume("custom", { resume_template: "--resume {id}" })).toBe(true);
    // A second-account Claude wrapper resumes the way Claude does, template or not.
    expect(runnerCanResume("custom", { claude_family: true })).toBe(true);
    // A malformed template is not a method.
    expect(runnerCanResume("custom", { resume_template: "--resume" })).toBe(false);
  });

  it("leaves built-in runners answering from the kernel's own table", () => {
    expect(runnerCanResume("claude")).toBe(true);
    expect(runnerCanResume("codex")).toBe(true);
  });
});
