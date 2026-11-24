import { describe, expect, it } from "vitest";
import { buildCanvasBootstrapBrief, buildCanvasIdentityPreamble, buildLiveAgentSpawnSpec, CANVAS_NOTES_CAPABILITY, CANVAS_PEER_MESSAGING_CAPABILITY, matchCustomRunnerByCommand, resolveRunnerLaunch } from "../live-agent-spawn";

// Measured 2026-09-12 against the running app: the whole command is typed into a shell on the
// resume path, and at ~2.5 KB the tty's input queue fills. zsh then rings the bell for every
// further character and DISCARDS it — the pane's ring buffer ends in ~150 BELs, the closing quote
// never lands, and no CLI ever starts. Naming a file keeps the typed line ~200 bytes, so the queue
// is never pressured (`plans/codecanvas-session-refactor/issues/08`).
// A resume used to be forced onto the shell path, where its ~3 KB command overran the tty's input
// queue. argv has carried everything it needs all along — the session flag is part of the base
// command, and the persona rides as one raw element (`plans/codecanvas-session-refactor/issues/08`).
describe("resume via argv (no shell at all)", () => {
  it("carries the session flag in argv", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "claude",
      sessionId: "5b5cb2ea-3512-4781-b240-efcb7a05aeda",
      sessionMode: "resume",
    });
    expect(spec.argv).not.toBeNull();
    const idx = spec.argv!.indexOf("--resume");
    expect(idx).toBeGreaterThan(0);
    expect(spec.argv![idx + 1]).toBe("5b5cb2ea-3512-4781-b240-efcb7a05aeda");
  });

  it("keeps the persona as one raw argv element beside the resume flag", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "claude",
      agentName: "Probe",
      includePeerCapability: true,
      sessionId: "5b5cb2ea-3512-4781-b240-efcb7a05aeda",
      sessionMode: "resume",
    });
    const idx = spec.argv!.indexOf("--append-system-prompt");
    expect(spec.argv![idx + 1]).toContain("You are Probe");
    expect(spec.argv![idx + 1].startsWith("'")).toBe(false);
    expect(spec.argv).toContain("--resume");
  });
});

describe("system prompt via file (typed path)", () => {
  it("names the file instead of inlining the persona", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "claude",
      agentName: "Probe",
      includePeerCapability: true,
      systemPromptFile: "/Users/x/.lotus/personas/agent-1.txt",
    });
    expect(spec.command).toContain(`--append-system-prompt "$(cat '/Users/x/.lotus/personas/agent-1.txt')"`);
    expect(spec.command).not.toContain("You are Probe");
    expect(spec.command.length).toBeLessThan(400);
  });

  it("still hands argv the raw prompt, because a direct spawn needs no shell at all", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "claude",
      agentName: "Probe",
      includePeerCapability: true,
      systemPromptFile: "/Users/x/.lotus/personas/agent-1.txt",
    });
    const idx = spec.argv!.indexOf("--append-system-prompt");
    expect(spec.argv![idx + 1]).toContain("You are Probe");
  });

  it("exposes the prompt so the caller can write the file it just named", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", agentName: "Probe" });
    expect(spec.systemPrompt).toContain("You are Probe");
  });

  it("inlines as before when no file is named", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", agentName: "Probe" });
    expect(spec.command).toContain("You are Probe");
  });
});

describe("buildLiveAgentSpawnSpec — argv (direct shell-less spawn)", () => {
  it("emits argv tokens with the system prompt as ONE raw element (no shell quoting)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", agentName: "Rowan", includePeerCapability: true });
    expect(spec.argv).not.toBeNull();
    expect(spec.argv!.slice(0, 2)).toEqual(["claude", "--dangerously-skip-permissions"]);
    const promptIdx = spec.argv!.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThan(0);
    const prompt = spec.argv![promptIdx + 1];
    expect(prompt).toContain("Rowan");
    // Raw argv element — must NOT carry the shell quoting the typed command needs.
    expect(prompt.startsWith("'")).toBe(false);
  });

  it("pins the model as its own token pair", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", model: "opus" });
    expect(spec.argv).toEqual(["claude", "--dangerously-skip-permissions", "--model", "opus"]);
  });

  it("returns argv null when the base command needs a shell (quotes in extra flags) — shell path only", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", extraFlags: `--settings '{"a":1}'` });
    expect(spec.argv).toBeNull();
    expect(spec.command).toContain("--settings"); // typed path unaffected
  });

  it("tokenizes non-claude runners too (codex direct spawn)", () => {
    expect(buildLiveAgentSpawnSpec({ runner: "codex" }).argv).toEqual([
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("carries the resume session flag into argv (typed and direct stay equivalent)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", sessionId: "abc-1", sessionMode: "resume" });
    expect(spec.argv).toEqual(["claude", "--dangerously-skip-permissions", "--resume", "abc-1"]);
  });
});

describe("buildLiveAgentSpawnSpec", () => {
  it("injects the live persona contract via --append-system-prompt and spawns READY (no auto-submit) with no task", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", model: "claude-sonnet-4-6", permissionMode: "full", rolePrompt: "You are Skye." });
    expect(spec.command).toContain("claude --dangerously-skip-permissions");
    expect(spec.command).toContain("--model claude-sonnet-4-6");
    expect(spec.command).toContain("--append-system-prompt");
    // Persona (live contract + role) rides the system prompt — never typed as a task message.
    expect(spec.command).toContain("live agent");
    expect(spec.command).toContain("You are Skye.");
    expect(spec.command).not.toContain("There is no human available");
    // Bare spawn → nothing auto-submitted; the persona just sits ready.
    expect(spec.submitText).toBeNull();
  });

  it("auto-submits ONLY a concrete task when one is provided (persona stays in the system prompt)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", rolePrompt: "ROLE", task: "Fix the login bug." });
    expect(spec.submitText).toBe("Fix the login bug.");
    expect(spec.command).toContain("--append-system-prompt");
    expect(spec.command).not.toContain("Fix the login bug."); // the task is submitted, not baked into launch
  });

  it("does not pass --append-system-prompt to codex, but does pin its model with -m (persona is Fase 3; tuning is not)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "codex", model: "gpt-5.4-codex", rolePrompt: "ROLE" });
    expect(spec.command).not.toContain("--append-system-prompt");
    expect(spec.command).not.toContain("--model");
    expect(spec.command).toContain("-m gpt-5.4-codex");
    expect(spec.argv).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.4-codex"]);
  });

  it("carries codex's effort as a shell-quoted TOML override in the typed command and verbatim in argv", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "codex", permissionMode: "safe", effort: "xhigh" });
    expect(spec.command).toBe(`codex -c 'model_reasoning_effort="xhigh"'`);
    expect(spec.argv).toEqual(["codex", "-c", 'model_reasoning_effort="xhigh"']);
  });

  it("passes --effort beside --model on claude", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", model: "sonnet", effort: "high" });
    expect(spec.argv).toEqual(["claude", "--dangerously-skip-permissions", "--model", "sonnet", "--effort", "high"]);
    expect(spec.command).toBe("claude --dangerously-skip-permissions --model sonnet --effort high");
  });

  it("leaves a custom runner's command alone: it owns its own --model", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "custom", runnerCommand: "claude --agent acme --model opus", model: "haiku", effort: "low" });
    expect(spec.command).toBe("claude --agent acme --model opus");
  });

  it("honours safe (read-only) mode in both the spawn command and the injected contract", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", permissionMode: "safe", rolePrompt: "ROLE" });
    expect(spec.command).not.toContain("--dangerously-skip-permissions");
    expect(spec.command).toContain("--append-system-prompt");
    expect(spec.command).toContain("READ-ONLY");
  });

  it("threads applied skills and upstream context into the injected persona contract", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "claude",
      rolePrompt: "ROLE",
      appliedSkills: ["tdd"],
      context: [{ type: "note", content: "the spec" }],
    });
    expect(spec.command).toContain("Skills to apply");
    expect(spec.command).toContain("the spec");
  });

  it("defaults the runner to claude", () => {
    expect(buildLiveAgentSpawnSpec({ rolePrompt: "ROLE" }).command).toContain("claude --dangerously-skip-permissions");
  });

  it("is CNVS-pure with no role and no model: bare command, no --append-system-prompt, no --model (ADR-0027)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude" });
    expect(spec.command).toBe("claude --dangerously-skip-permissions");
    expect(spec.command).not.toContain("--append-system-prompt");
    expect(spec.command).not.toContain("--model");
  });

  it("honors an explicit model without a role overlay (NL 'spawn a claude opus agent')", () => {
    // No rolePrompt → still CNVS-pure (no --append-system-prompt), but the chosen model is pinned.
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", model: "opus" });
    expect(spec.command).toBe("claude --dangerously-skip-permissions --model opus");
    expect(spec.command).not.toContain("--append-system-prompt");
  });

  it("injects the peer-messaging capability into a bare claude launch when opted in (ADR-0030), without a persona", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", includePeerCapability: true });
    expect(spec.command).toContain("--append-system-prompt");
    expect(spec.command).toContain("lotus_list_fleet"); // the capability line
    expect(spec.command).not.toContain("live agent"); // no persona contract — capability only
    expect(spec.submitText).toBeNull();
  });

  it("peer capability targets by pane_id (not display_name) — resolves the tool-contract contradiction (Phase 3)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", includePeerCapability: true });
    // The dispatch schema says "use pane_id, never workspace_id/display_name"; the prompt must AGREE.
    expect(spec.command).toContain("pane_id");
    expect(spec.command).toContain("lotus_dispatch_to_cell");
    // display_name / aliases are for recognition, not targeting.
    expect(spec.command).toMatch(/display_name/);
    expect(spec.command).toMatch(/alias/i);
    // No longer instructs targeting "by their name" (the contradiction we're removing).
    expect(spec.command).not.toContain("dispatch to them by their name");
  });

  it("peer capability tells the agent to re-list / report inconsistency instead of claiming a visible teammate is gone", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", includePeerCapability: true });
    expect(spec.command).toMatch(/lotus_list_fleet again|call.*again/i);
    expect(spec.command).toMatch(/inconsistent|inconsistency/i);
  });

  it("peer capability teaches the reply-back protocol in both directions (push, not poll)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", includePeerCapability: true });
    // Delegating: ask for a report instead of polling for completion.
    expect(spec.command).toContain("replyTo");
    // Receiving: a dispatch that names a sender gets its result dispatched back.
    expect(spec.command).toMatch(/dispatch your result back/i);
  });

  it("does NOT inject the capability by default — a bare launch stays CNVS-pure (ADR-0027 invariant intact)", () => {
    expect(buildLiveAgentSpawnSpec({ runner: "claude" }).command).toBe("claude --dangerously-skip-permissions");
  });

  it("does not inject the capability for codex (no system-prompt flag) even when opted in", () => {
    expect(buildLiveAgentSpawnSpec({ runner: "codex", includePeerCapability: true }).command).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox",
    );
  });

  describe("Phase 5: runner-agnostic peer bootstrap (codex/custom have no --append-system-prompt)", () => {
    it("delivers identity + peer capability as a first-turn bootstrap for codex (not the command)", () => {
      const spec = buildLiveAgentSpawnSpec({ runner: "codex", agentName: "Nova", includePeerCapability: true });
      // Command stays bare — no system-prompt flag on codex.
      expect(spec.command).toBe("codex --dangerously-bypass-approvals-and-sandbox");
      // The bootstrap carries who-you-are + how-to-reach-peers as plain text to submit once.
      expect(spec.bootstrapText).toBeTruthy();
      expect(spec.bootstrapText).toContain("You are Nova");
      expect(spec.bootstrapText).toContain("lotus_list_fleet");
      expect(spec.bootstrapText).toContain("lotus_dispatch_to_cell");
    });

    it("keeps the codex bootstrap LEAN — names the tools but defers argument-level protocol to the MCP tool schemas", () => {
      // codex has the Lotus MCP wired (config.toml [mcp_servers.lotus]), so the tool descriptions
      // themselves carry the pane_id/workspace_id/replyTo rules. Re-typing that prose into a VISIBLE
      // first-turn message just floods the terminal — the brief only makes the agent aware.
      const spec = buildLiveAgentSpawnSpec({ runner: "codex", agentName: "Nova", includePeerCapability: true, includeCanvasControlCapability: true });
      expect(spec.bootstrapText).toContain("lotus_list_fleet");
      expect(spec.bootstrapText).toContain("lotus_dispatch_to_cell");
      expect(spec.bootstrapText).toContain("replyTo");
      // The redundant MCP-schema detail must NOT be re-typed into the terminal.
      expect(spec.bootstrapText).not.toContain("workspace_id");
      expect(spec.bootstrapText).not.toContain("display_name");
      // Substantially leaner than the invisible claude-family capability constant it replaces.
      expect(spec.bootstrapText!.length).toBeLessThan(CANVAS_PEER_MESSAGING_CAPABILITY.length);
    });

    it("keeps the user task separate from the bootstrap (bootstrap is not the task)", () => {
      const spec = buildLiveAgentSpawnSpec({ runner: "codex", agentName: "Nova", includePeerCapability: true, task: "Fix the header" });
      expect(spec.submitText).toBe("Fix the header");
      expect(spec.bootstrapText).toContain("You are Nova");
      expect(spec.bootstrapText).not.toContain("Fix the header");
    });

    it("includes the canvas-control capability in the bootstrap when opted in", () => {
      const spec = buildLiveAgentSpawnSpec({ runner: "codex", agentName: "Nova", includePeerCapability: true, includeCanvasControlCapability: true });
      expect(spec.bootstrapText).toContain("lotus_focus_cell");
    });

    it("emits NO bootstrap for a bare codex launch (CNVS-pure — no peer capability, no identity)", () => {
      const spec = buildLiveAgentSpawnSpec({ runner: "codex" });
      expect(spec.bootstrapText ?? null).toBeNull();
    });

    it("claude-family runners carry the capability in --append-system-prompt, NOT a bootstrap", () => {
      const spec = buildLiveAgentSpawnSpec({ runner: "claude", agentName: "Atlas", includePeerCapability: true });
      expect(spec.command).toContain("--append-system-prompt");
      expect(spec.bootstrapText ?? null).toBeNull();
    });

    it("a custom-but-Claude-family runner uses the claude system-prompt path (no bootstrap)", () => {
      const spec = buildLiveAgentSpawnSpec({ runner: "custom", runnerCommand: "ccs acme", claudeFamily: true, agentName: "Sky", includePeerCapability: true });
      expect(spec.bootstrapText ?? null).toBeNull();
    });

    it("a non-Claude custom runner gets the first-turn bootstrap", () => {
      const spec = buildLiveAgentSpawnSpec({ runner: "custom", runnerCommand: "my-cli", agentName: "Rex", includePeerCapability: true });
      expect(spec.bootstrapText).toContain("You are Rex");
      expect(spec.bootstrapText).toContain("lotus_list_fleet");
    });
  });

  describe("buildCanvasBootstrapBrief — lean first-turn brief for non-claude runners", () => {
    it("returns an empty string when nothing is requested (bare CNVS launch)", () => {
      expect(buildCanvasBootstrapBrief({})).toBe("");
    });

    it("identity-only when a name is set but no capabilities are opted in", () => {
      const brief = buildCanvasBootstrapBrief({ name: "Nova" });
      expect(brief).toContain("You are Nova");
      expect(brief).not.toContain("lotus_list_fleet");
      expect(brief).not.toContain("lotus_focus_cell");
    });

    it("names current teammates from the roster, excluding self (case-insensitive)", () => {
      const brief = buildCanvasBootstrapBrief({ name: "Nova", roster: ["Atlas", "nova", "Sage"] });
      expect(brief).toContain("Atlas");
      expect(brief).toContain("Sage");
      // Self is not listed as its own teammate.
      expect(brief).not.toMatch(/teammates[^.]*\bNova\b/i);
    });

    it("adds a single lean peer line naming the tools, not the argument protocol", () => {
      const brief = buildCanvasBootstrapBrief({ name: "Nova", includePeerCapability: true });
      expect(brief).toContain("lotus_list_fleet");
      expect(brief).toContain("lotus_dispatch_to_cell");
      expect(brief).toContain("replyTo");
      expect(brief).not.toContain("workspace_id");
    });

    it("adds the canvas-control line only when opted in", () => {
      expect(buildCanvasBootstrapBrief({ name: "Nova", includePeerCapability: true })).not.toContain("lotus_focus_cell");
      expect(buildCanvasBootstrapBrief({ name: "Nova", includeCanvasControlCapability: true })).toContain("lotus_focus_cell");
    });

    it("emits a peer/control brief even with no name (infrastructure awareness without identity)", () => {
      const brief = buildCanvasBootstrapBrief({ includePeerCapability: true });
      expect(brief).toContain("lotus_list_fleet");
      expect(brief).not.toContain("You are");
    });
  });

  it("composes the capability AFTER the persona when a role is also set", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", rolePrompt: "You are Skye.", includePeerCapability: true });
    expect(spec.command).toContain("You are Skye."); // persona
    expect(spec.command).toContain("lotus_list_fleet"); // capability
  });

  it("injects the canvas-control capability for claude only when opted in", () => {
    const on = buildLiveAgentSpawnSpec({ runner: "claude", includeCanvasControlCapability: true });
    expect(on.command).toContain("lotus_focus_cell");
    expect(on.command).toContain("lotus_arrange_canvas");
    const off = buildLiveAgentSpawnSpec({ runner: "claude" });
    expect(off.command).not.toContain("lotus_focus_cell");
    expect(off.command).not.toContain("--append-system-prompt");
  });

  it("does not inject canvas-control for codex (no system-prompt flag) even when opted in", () => {
    expect(buildLiveAgentSpawnSpec({ runner: "codex", includeCanvasControlCapability: true }).command).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("composes peer + canvas-control capabilities together when both opted in", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", includePeerCapability: true, includeCanvasControlCapability: true });
    expect(spec.command).toContain("lotus_list_fleet"); // peer
    expect(spec.command).toContain("lotus_arrange_canvas"); // canvas-control
  });

  it("injects formatted CodeCanvas project memory into claude-family system prompts", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "claude",
      agentName: "Rowan",
      projectMemoryPrompt: "# CodeCanvas project memory\n- [decision; project] Use SQLite memory.",
    });
    expect(spec.command).toContain("# CodeCanvas project memory");
    expect(spec.command).toContain("Use SQLite memory");
    expect(spec.command.indexOf("You are Rowan,")).toBeLessThan(spec.command.indexOf("# CodeCanvas project memory"));
  });

  it("does not inject project memory for codex because there is no system-prompt flag", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "codex",
      projectMemoryPrompt: "# CodeCanvas project memory\n- secret",
    });
    expect(spec.command).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });

  it("delivers the lean project-memory brief to non-Claude runners as first-turn text", () => {
    // Without this a codex or custom runner works in the project while blind to its rules: the
    // system-prompt path that carries memory for claude-family does not exist for them.
    const spec = buildLiveAgentSpawnSpec({
      runner: "codex",
      agentName: "Nova",
      includePeerCapability: true,
      projectMemoryBrief: "Project memory (shared, applies to your work here):\n- RULE: Use Bun, never npm.",
    });
    expect(spec.bootstrapText).toContain("RULE: Use Bun, never npm.");
    expect(spec.command).not.toContain("Use Bun");
  });

  it("types only the brief, never the full memory block, into a terminal runner", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "codex",
      agentName: "Nova",
      projectMemoryPrompt: "# Project memory — shared, this project\n## Facts\n1. long block",
      projectMemoryBrief: "Project memory (shared, applies to your work here):\n- RULE: Use Bun.",
    });
    expect(spec.bootstrapText).toContain("RULE: Use Bun.");
    expect(spec.bootstrapText).not.toContain("## Facts");
  });

  it("keeps claude-family on the system prompt, with nothing typed into the pane", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "claude",
      agentName: "Rowan",
      projectMemoryPrompt: "# Project memory — shared, this project",
      projectMemoryBrief: "Project memory (shared, applies to your work here):\n- RULE: Use Bun.",
    });
    expect(spec.command).toContain("# Project memory");
    expect(spec.bootstrapText).toBeNull();
  });

  it("leaves the bootstrap brief alone when the project has no rules to state", () => {
    const withMemory = buildLiveAgentSpawnSpec({ runner: "codex", agentName: "Nova", projectMemoryBrief: "" });
    const without = buildLiveAgentSpawnSpec({ runner: "codex", agentName: "Nova" });
    expect(withMemory.bootstrapText).toBe(without.bootstrapText);
  });

  it("launches a cursor runner CNVS-pure", () => {
    expect(buildLiveAgentSpawnSpec({ runner: "cursor" }).command).toBe("cursor-agent --yolo");
  });

  it("appends Runner Registry extra flags to a bare launch", () => {
    expect(buildLiveAgentSpawnSpec({ runner: "claude", extraFlags: "--add-dir /tmp" }).command).toBe(
      "claude --dangerously-skip-permissions --add-dir /tmp",
    );
  });

  it("still auto-submits a task on a bare (no-role) launch", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", task: "Fix it." });
    expect(spec.command).toBe("claude --dangerously-skip-permissions");
    expect(spec.submitText).toBe("Fix it.");
  });

  it("pre-mints a fresh session via --session-id on first launch (ADR-0027 Phase 5)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", sessionId: "uuid-1", sessionMode: "new" });
    expect(spec.command).toBe("claude --dangerously-skip-permissions --session-id uuid-1");
  });

  it("resumes a prior session on reopen via --resume (default mode)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", sessionId: "sess-42", sessionMode: "resume" });
    expect(spec.command).toBe("claude --dangerously-skip-permissions --resume sess-42");
    // mode defaults to resume
    expect(buildLiveAgentSpawnSpec({ runner: "claude", sessionId: "sess-42" }).command).toBe(
      "claude --dangerously-skip-permissions --resume sess-42",
    );
  });

  it("session flag composes with extra flags (session before extras)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", sessionId: "s1", sessionMode: "new", extraFlags: "--add-dir /tmp" });
    expect(spec.command).toBe("claude --dangerously-skip-permissions --session-id s1 --add-dir /tmp");
  });

  it("ignores session pinning for a runner without verified support (codex)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "codex", sessionId: "s1", sessionMode: "new" });
    expect(spec.command).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });

  // --- Canvas identity overlay (Layer 1+2+3+4): give a bare canvas agent self-knowledge + voice ---

  it("injects the canvas identity preamble when agentName is set (claude-family)", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", agentName: "Rowan" });
    expect(spec.command).toContain("--append-system-prompt");
    expect(spec.command).toContain("You are Rowan,"); // self-knowledge (Layer 1)
    expect(spec.command).toContain("capable generalist"); // owns identity, no invented job title
    expect(spec.command).toContain("How you carry yourself"); // house voice (Layer 2)
    expect(spec.submitText).toBeNull();
  });

  it("keeps the CNVS-pure invariant: no agentName → still a bare launch (no identity, no --append-system-prompt)", () => {
    expect(buildLiveAgentSpawnSpec({ runner: "claude" }).command).toBe("claude --dangerously-skip-permissions");
  });

  it("does not inject identity for codex (no system-prompt flag) even with agentName", () => {
    expect(buildLiveAgentSpawnSpec({ runner: "codex", agentName: "Rowan" }).command).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("composes identity BEFORE the peer + canvas-control capabilities (canvas spawn shape)", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "claude",
      agentName: "Rowan",
      includePeerCapability: true,
      includeCanvasControlCapability: true,
    });
    const cmd = spec.command;
    expect(cmd).toContain("You are Rowan,"); // identity
    expect(cmd).toContain("lotus_list_fleet"); // peer capability
    expect(cmd).toContain("lotus_arrange_canvas"); // canvas-control capability
    // Identity leads the system prompt; the mechanical capability lines follow it.
    expect(cmd.indexOf("You are Rowan,")).toBeLessThan(cmd.indexOf("lotus_list_fleet"));
  });

  it("threads a teammate roster snapshot into the identity preamble", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", agentName: "Rowan", roster: ["Sage", "Iris", "Wren"] });
    expect(spec.command).toContain("Sage");
    expect(spec.command).toContain("Iris");
    expect(spec.command).toContain("Wren");
  });

  it("composes identity alongside an explicit role overlay", () => {
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", agentName: "Rowan", rolePrompt: "You are a reviewer." });
    expect(spec.command).toContain("You are a reviewer."); // role overlay
    expect(spec.command).toContain("You are Rowan,"); // identity overlay
  });

  // --- custom runner that is actually Claude (2nd account / profile wrapper) → claude-family treatment ---

  it("keeps a plain custom runner bare (no system prompt, no model) — non-claude by default", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "custom",
      runnerCommand: "my-agent --yolo",
      model: "opus",
      agentName: "Nova",
      includePeerCapability: true,
    });
    expect(spec.command).toBe("my-agent --yolo");
    expect(spec.command).not.toContain("--append-system-prompt");
    expect(spec.command).not.toContain("--model");
  });

  it("promotes a custom-but-Claude runner (claudeFamily) to full treatment: model + peer capability + identity", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "custom",
      runnerCommand: "claude --profile second --dangerously-skip-permissions",
      model: "claude-opus-4-8",
      agentName: "Nova",
      claudeFamily: true,
      includePeerCapability: true,
    });
    expect(spec.command).toContain("claude --profile second"); // the user's wrapper command
    expect(spec.command).toContain("--model claude-opus-4-8"); // model now pinned
    expect(spec.command).toContain("--append-system-prompt");
    expect(spec.command).toContain("lotus_list_fleet"); // can now initiate peer messaging
    expect(spec.command).toContain("You are Nova,"); // identity injected
  });
});

describe("matchCustomRunnerByCommand (custom-runner config resolution)", () => {
  const runners = [
    { id: "claude", custom: false, command: "claude --dangerously-skip-permissions", claude_family: false },
    { id: "custom-acme", custom: true, command: "ccs acme --dangerously-skip-permissions", claude_family: true },
    { id: "custom-hss", custom: true, command: "ccs initech --dangerously-skip-permissions", claude_family: true },
  ];

  it("matches the custom entry by exact launch command (recovers claude_family)", () => {
    const match = matchCustomRunnerByCommand("ccs acme --dangerously-skip-permissions", runners);
    expect(match?.id).toBe("custom-acme");
    expect(match?.claude_family).toBe(true);
  });

  it("trims whitespace on both sides before comparing", () => {
    expect(matchCustomRunnerByCommand("  ccs initech --dangerously-skip-permissions  ", runners)?.id).toBe("custom-hss");
  });

  it("never matches a non-custom (built-in) entry, even if the command is identical", () => {
    expect(matchCustomRunnerByCommand("claude --dangerously-skip-permissions", runners)).toBeNull();
  });

  it("returns null for an empty command or no match", () => {
    expect(matchCustomRunnerByCommand("", runners)).toBeNull();
    expect(matchCustomRunnerByCommand(undefined, runners)).toBeNull();
    expect(matchCustomRunnerByCommand("ccs unknown", runners)).toBeNull();
  });
});

describe("buildCanvasIdentityPreamble (Layer 1+2+3+4)", () => {
  it("names the agent and instructs it to own that identity (Layer 1)", () => {
    const text = buildCanvasIdentityPreamble({ name: "Rowan" });
    expect(text).toContain("You are Rowan,");
    expect(text).toContain("own it");
    expect(text).toContain("nickname"); // explicitly told not to treat it as a nickname
    expect(text).toContain("wasn't assigned");
  });

  it("carries a consistent house voice + anti-formatting + voice-modality guidance (Layer 2+4)", () => {
    const text = buildCanvasIdentityPreamble({ name: "Rowan" });
    expect(text).toContain("How you carry yourself");
    expect(text).toContain("Role / Persona / Task"); // told NOT to answer as a formatted report
    expect(text).toMatch(/by voice|read aloud/); // conversational for spoken interaction
    expect(text).toContain("generalist"); // no invented job title
  });

  it("owns being an AI: never claims to be human or to have taken physical actions (Layer 4)", () => {
    // Voice interaction makes this load-bearing: a spoken "I'll grab it from the office" or an
    // agent playing human erodes trust instantly. Honesty about being an AI is identity-owning,
    // not self-deprecating — it must coexist with the "drop the AI self-deprecation" voice rule.
    const text = buildCanvasIdentityPreamble({ name: "Rowan" });
    expect(text).toContain("never claim to be human");
    expect(text).toMatch(/physical/i); // no claimed real-world/physical actions
    expect(text).toContain("Drop the AI self-deprecation"); // the two rules coexist
  });

  it("lists current teammates when a roster is provided, excluding self (case-insensitive)", () => {
    const text = buildCanvasIdentityPreamble({ name: "Rowan", roster: ["Sage", "rowan", "Iris"] });
    expect(text).toContain("Sage");
    expect(text).toContain("Iris");
    expect(text).not.toMatch(/include[^.]*\browan\b/i); // self filtered out of the teammate list
    expect(text).toContain("lotus_list_fleet"); // still points at the live roster
  });

  it("falls back to a generic team line when no teammates are present", () => {
    const text = buildCanvasIdentityPreamble({ name: "Rowan", roster: [] });
    expect(text).toContain("may join the canvas");
    expect(text).toContain("lotus_list_fleet");
  });

  it("trims the name and returns empty for a blank name (hardening)", () => {
    expect(buildCanvasIdentityPreamble({ name: "  Rowan  " })).toContain("You are Rowan,");
    expect(buildCanvasIdentityPreamble({ name: "   " })).toBe("");
    expect(buildCanvasIdentityPreamble({ name: "" })).toBe("");
  });

  it("ignores blank/whitespace roster entries", () => {
    const text = buildCanvasIdentityPreamble({ name: "Rowan", roster: ["  ", "", "Iris"] });
    expect(text).toContain("Iris");
    expect(text).not.toContain("may join the canvas"); // has a real teammate → not the empty fallback
  });
});

describe("resolveRunnerLaunch (Runner Registry → spawn, ADR-0027 Phase 3)", () => {
  /**
   * The bug an operator hit on a real phone, 2026-08-27: they chose `manual` and the cell was
   * born with `--dangerously-skip-permissions`.
   *
   * Rule 1 tested for the single word `"safe"`, so every other gated stop fell through to the
   * registry — whose `skip_permissions` defaults to **true** for an unconfigured runner. The
   * question rule 1 means to ask is *is this a request to be gated*, and these pin it.
   */
  it.each(["manual", "plan", "acceptEdits", "read-only", "auto"])(
    "lets a node asking for %s beat the registry's YOLO",
    (mode) => {
      expect(
        resolveRunnerLaunch({ nodePermissionMode: mode, registrySkipPermissions: true }).permissionMode,
      ).toBe(mode);
    },
  );

  /**
   * And the other direction is unchanged: a node asking for the gate *off* does not outrank a
   * registry that was configured to keep it on. Only safety wins by default.
   */
  it.each(["full", "yolo", "bypassPermissions"])(
    "still lets the registry veto a node asking for %s",
    (mode) => {
      expect(
        resolveRunnerLaunch({ nodePermissionMode: mode, registrySkipPermissions: false }).permissionMode,
      ).toBe("safe");
    },
  );

  it("no registry entry → keeps the node's mode (default YOLO/full), no extra flags", () => {
    expect(resolveRunnerLaunch({ nodePermissionMode: "full" })).toEqual({ permissionMode: "full", extraFlags: undefined });
    expect(resolveRunnerLaunch({})).toEqual({ permissionMode: "full", extraFlags: undefined });
  });

  it("registry skip-permissions on/off drives the effective permission mode", () => {
    expect(resolveRunnerLaunch({ nodePermissionMode: "full", registrySkipPermissions: true }).permissionMode).toBe("full");
    expect(resolveRunnerLaunch({ nodePermissionMode: "full", registrySkipPermissions: false }).permissionMode).toBe("safe");
  });

  it("a node pinned to safe stays read-only even if the registry enables YOLO", () => {
    expect(resolveRunnerLaunch({ nodePermissionMode: "safe", registrySkipPermissions: true }).permissionMode).toBe("safe");
  });

  it("passes through registry extra flags, dropping blank ones", () => {
    expect(resolveRunnerLaunch({ registryExtraFlags: "--model opus" }).extraFlags).toBe("--model opus");
    expect(resolveRunnerLaunch({ registryExtraFlags: "   " }).extraFlags).toBeUndefined();
  });

  it("end-to-end: registry config flows into the spawn command", () => {
    const launch = resolveRunnerLaunch({ nodePermissionMode: "full", registrySkipPermissions: false, registryExtraFlags: "--add-dir /tmp" });
    const spec = buildLiveAgentSpawnSpec({ runner: "claude", permissionMode: launch.permissionMode, extraFlags: launch.extraFlags });
    // skip-permissions off → no --dangerously-skip-permissions; extra flags appended.
    expect(spec.command).toBe("claude --add-dir /tmp");
  });
});

// ── Profile runners resume too (plans/codecanvas-session-widget/, Slice 06 hardening) ────────────

describe("session flags for custom runners", () => {
  // The bug this closes: HSS (`ccs initech`) is Claude behind a wrapper, captured a session id,
  // and then launched bare — the id was stored and never used, so reopening started a new
  // conversation. Measured against a real run on 2026-09-07.
  it("gives a claude-family custom runner Claude's own resume flag", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "custom",
      runnerCommand: "ccs initech --dangerously-skip-permissions",
      claudeFamily: true,
      sessionId: "sess-1",
      sessionMode: "resume",
    });
    expect(spec.command).toContain("--resume sess-1");
  });

  // Claude ignores --session-id, so there is nothing honest to fall back to for a fresh session.
  it("does not invent a pre-mint flag for a claude-family custom runner", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "custom",
      runnerCommand: "ccs initech",
      claudeFamily: true,
      sessionId: "sess-1",
      sessionMode: "new",
    });
    expect(spec.command).not.toContain("sess-1");
  });

  it("uses a non-claude runner's own declared template", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "custom",
      runnerCommand: "grok",
      resumeTemplate: "--resume {id}",
      sessionId: "sess-9",
      sessionMode: "resume",
    });
    expect(spec.command).toContain("grok");
    expect(spec.command).toContain("--resume sess-9");
  });

  it("leaves a custom runner that declared nothing exactly as it was", () => {
    const spec = buildLiveAgentSpawnSpec({
      runner: "custom",
      runnerCommand: "pi",
      sessionId: "sess-9",
      sessionMode: "resume",
    });
    expect(spec.command).not.toContain("sess-9");
  });
});

describe("notes awareness (ADR-0047)", () => {
  it("tells every canvas agent to read its wired notes with lotus_notes_read", () => {
    expect(CANVAS_NOTES_CAPABILITY).toContain("lotus_notes_read");
    // The slow path Lyra took in the app: no tool loaded → curl the IPC port → sandbox retry.
    expect(CANVAS_NOTES_CAPABILITY).toContain("ToolSearch");
    expect(CANVAS_NOTES_CAPABILITY).toMatch(/Never read notes by calling the Lotus app over HTTP/);
    // Ivo's answer in the app: "Agents can only read notes … paste it yourself".
    expect(CANVAS_NOTES_CAPABILITY).toContain("lotus_notes_write");
    const brief = buildCanvasBootstrapBrief({ name: "Zia", includePeerCapability: true });
    expect(brief).toContain("lotus_notes_read");
    expect(buildCanvasBootstrapBrief({ name: "Zia" })).not.toContain("lotus_notes_read");
  });
});
