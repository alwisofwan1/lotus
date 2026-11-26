import { describe, expect, it } from "vitest";
import type { CodeCanvasMemoryWriteInput } from "@/lib/tauri/codecanvas";
import {
  CODE_LIVE_VOICE_CLOSE_REPLY,
  codeLiveVoiceContextKey,
  createCodeLiveVoiceTools,
  type CodeLiveVoiceDeps,
} from "../code-live-voice-tools";
import type { CodeVoicePane, CodeVoiceSendOutcome } from "../code-voice-adapter";

interface Setup {
  panes?: CodeVoicePane[];
  focusedId?: string | null;
  sendOutcome?: CodeVoiceSendOutcome;
  output?: Record<string, string>;
  projectId?: string | null;
  canClose?: boolean;
  /** No pendingSend: a risky message is refused instead of asked about. */
  noConfirmSend?: boolean;
}

/** A Code window of fake panes, recording what Live Voice did to them. */
function makeCode(setup: Setup = {}) {
  const panes = setup.panes ?? [
    { id: "p1", name: "Rowan", kind: "terminal", activity: "working" },
    { id: "p2", name: "Release notes", kind: "thread", activity: "idle" },
    { id: "p3", name: "Docs site", kind: "browser" },
  ];
  const focused: string[] = [];
  const sent: Array<{ paneId: string; text: string }> = [];
  const spawned: string[] = [];
  const written: CodeCanvasMemoryWriteInput[] = [];
  const closed: string[] = [];
  const deps: CodeLiveVoiceDeps = {
    getPanes: () => panes,
    focusedId: () => (setup.focusedId === undefined ? "p1" : setup.focusedId),
    focus: (paneId) => focused.push(paneId),
    send: async (paneId, text) => {
      sent.push({ paneId, text });
      return setup.sendOutcome ?? { ok: true };
    },
    launchable: () => ["Claude Code", "Codex"],
    spawn: (agent) => {
      spawned.push(agent);
      return "p9";
    },
    readOutput: (paneId) => setup.output?.[paneId] ?? null,
    projectId: setup.projectId === undefined ? "cp_1" : setup.projectId,
    memoryWrite: async (input) => {
      written.push(input);
      return { id: "m1" } as never;
    },
    memorySearch: async () => [{ item: { title: "Ship on Friday", body: "Ship on Friday." } } as never],
    ...(setup.noConfirmSend ? {} : { pendingSend: { current: null } }),
    ...(setup.canClose ? { close: (paneId: string) => closed.push(paneId), pendingClose: { current: null } } : {}),
  };
  const live = createCodeLiveVoiceTools(deps);
  const run = (name: string, args: Record<string, unknown> = {}) =>
    live.execute({ callId: "c1", name, args }) as Promise<{ ok: boolean; speak?: string; summary?: string; error?: string }>;
  return { deps, live, run, focused, sent, spawned, written, closed };
}

/** The agent names `say_to_agent` offers the model. */
function agentEnum(live: ReturnType<typeof createCodeLiveVoiceTools>): unknown {
  const say = live.tools.find((tool) => tool.name === "say_to_agent") as { parameters?: { properties?: { target?: { enum?: unknown } } } } | undefined;
  return say?.parameters?.properties?.target?.enum;
}

describe("Code Live Voice tools", () => {
  describe("a risky message waits for a spoken yes", () => {
    it("asks before telling an agent to push, and sends the asked text on yes", async () => {
      const { run, sent } = makeCode();
      const asked = await run("dispatch", { target: "Rowan", task: "commit the poem and push to main" });
      expect(asked.speak).toBe('That asks Rowan to push: "commit the poem and push to main". Should I send it?');
      expect(sent).toEqual([]);
      // The model re-words it on the yes; the user heard the first wording, so that one goes.
      await run("dispatch", { target: "Rowan", task: "push it", confirm: true });
      expect(sent).toEqual([{ paneId: "p1", text: "commit the poem and push to main" }]);
    });

    it("forgets the question when the conversation moves on, or the yes names another agent", async () => {
      const { run, sent } = makeCode({ panes: [{ id: "p1", name: "Rowan", kind: "terminal" }, { id: "p4", name: "Kai", kind: "terminal" }] });
      await run("say_to_agent", { target: "Rowan", message: "hapus folder build" });
      await run("focus", { target: "Kai" });
      expect((await run("say_to_agent", { target: "Rowan", message: "hapus folder build", confirm: true })).speak).toMatch(/Should I send it\?$/);
      await run("dispatch", { target: "Kai", task: "merge it", confirm: true });
      expect(sent).toEqual([]);
    });

    it("asks when the voice model marks it risky, whatever the words", async () => {
      const { run, sent } = makeCode();
      const asked = await run("dispatch", { target: "Rowan", task: "taruh puisinya di GitHub", risky: "high" });
      expect(asked.speak).toBe('That asks Rowan to do something that leaves this computer or is hard to undo: "taruh puisinya di GitHub". Should I send it?');
      expect(sent).toEqual([]);
    });

    it("asks on the words even when the model says it is safe", async () => {
      const { run, sent } = makeCode();
      expect((await run("dispatch", { target: "Rowan", task: "naikkan ke GitHub", risky: "none" })).speak).toMatch(/deploy or publish/);
      expect((await run("dispatch", { target: "Rowan", task: "bersihkan folder lama", risky: "none" })).speak).toMatch(/delete something/);
      expect(sent).toEqual([]);
    });

    it("sends safe messages straight away", async () => {
      const { run, sent } = makeCode();
      await run("dispatch", { target: "Rowan", task: "write a short poem" });
      expect(sent).toEqual([{ paneId: "p1", text: "write a short poem" }]);
    });

    it("refuses a risky message where no yes can be asked", async () => {
      const { run, sent } = makeCode({ noConfirmSend: true });
      expect(await run("dispatch", { target: "Rowan", task: "git push" })).toMatchObject({ ok: false });
      expect(sent).toEqual([]);
    });
  });

  it("offers the pane tools and no close tool", () => {
    const { live } = makeCode();
    const names = live.tools.map((tool) => tool.name);
    for (const name of ["focus", "say_to_agent", "dispatch", "spawn_agent", "agent_status", "read_agent_output", "remember", "recall"]) {
      expect(names).toContain(name);
    }
    expect(names.some((name) => name.startsWith("close"))).toBe(false);
  });

  it("tells the model to answer a close with the ⌘W hint", () => {
    expect(makeCode().live.instructions).toContain(CODE_LIVE_VOICE_CLOSE_REPLY);
  });

  it("moves focus to the pane named", async () => {
    const { run, focused } = makeCode();
    const result = await run("focus", { target: "release notes" });
    expect(result.ok).toBe(true);
    expect(focused).toEqual(["p2"]);
  });

  it("tells an agent something, the way a typed Enter would", async () => {
    const { run, sent } = makeCode();
    const result = await run("say_to_agent", { target: "Rowan", message: "also check the tests" });
    expect(result.ok).toBe(true);
    expect(sent).toEqual([{ paneId: "p1", text: "also check the tests" }]);
  });

  it("dispatches a task to an agent", async () => {
    const { run, sent } = makeCode();
    await run("dispatch", { target: "Rowan", task: "review the auth module" });
    expect(sent).toEqual([{ paneId: "p1", text: "review the auth module" }]);
  });

  it("talks to the focused agent when no name was said", async () => {
    const { run, sent } = makeCode({ focusedId: "p2" });
    await run("say_to_agent", { message: "summarise it" });
    expect(sent).toEqual([{ paneId: "p2", text: "summarise it" }]);
  });

  it("says why a message did not reach the agent", async () => {
    const { run } = makeCode({ sendOutcome: { ok: false, reason: "This terminal has no live session yet." } });
    const result = await run("say_to_agent", { target: "Rowan", message: "hi" });
    expect(result.ok).toBe(false);
    expect(result.speak).toContain("no live session");
  });

  it("asks again for a name it cannot find, and sends nothing", async () => {
    const { run, sent } = makeCode();
    const result = await run("say_to_agent", { target: "Zelda", message: "hi" });
    expect(result.ok).toBe(false);
    expect(result.speak).toMatch(/Zelda/);
    expect(sent).toEqual([]);
  });

  it("never sends to a pane that is not an agent", async () => {
    const { run, sent } = makeCode();
    const result = await run("say_to_agent", { target: "Docs site", message: "hi" });
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  // The header reads "Soren · Test functionality": Soren is what the user calls it (ADR-0024).
  it("addresses an agent by its name, and by its title", async () => {
    const { live, run, sent } = makeCode({
      panes: [{ id: "p1", name: "Test functionality", persona: "Soren", kind: "terminal", agent: true }],
    });
    expect(agentEnum(live)).toEqual(["Soren"]);
    expect(live.instructions).toContain("Soren");
    expect(live.instructions).toContain("Test functionality");
    await run("say_to_agent", { target: "Soren", message: "one" });
    await run("say_to_agent", { target: "test functionality", message: "two" });
    expect(sent).toEqual([{ paneId: "p1", text: "one" }, { paneId: "p1", text: "two" }]);
  });

  // Live check 2: asked "how many agents, and who?", the model counted Remy and Orion AND "Claude Code
  // and Codex" — it had no way to know which CLI each pane runs, and read the launchable list as panes.
  it("says which CLI each agent runs, and that the launchable list is not open panes", () => {
    const { live } = makeCode({
      panes: [
        { id: "p1", name: "Remy", persona: "Remy", kind: "terminal", agent: true, runner: "Claude Code" },
        { id: "p2", name: "Orion", persona: "Orion", kind: "terminal", agent: true, runner: "Codex" },
      ],
    });
    expect(live.instructions).toContain("- Remy (terminal agent, runs Claude Code)");
    expect(live.instructions).toContain("- Orion (terminal agent, runs Codex)");
    expect(live.instructions).toMatch(/not open panes/);
  });

  // Typed into zsh, "Tolong buatkan sebuah puisi" is `command not found: Tolong`.
  it("never sends a message to a plain shell, even when it has focus", async () => {
    const { live, run, sent } = makeCode({
      panes: [
        { id: "p1", name: "Test functionality", persona: "Soren", kind: "terminal", agent: false },
        { id: "p2", name: "Zia", persona: "Zia", kind: "terminal", agent: true },
      ],
      focusedId: "p1",
    });
    expect(agentEnum(live)).toEqual(["Zia"]);
    expect((await run("say_to_agent", { target: "Soren", message: "hi" })).ok).toBe(false);
    await run("say_to_agent", { message: "write a poem" });
    expect(sent).toEqual([{ paneId: "p2", text: "write a poem" }]);
    expect((await run("focus", { target: "Soren" })).ok).toBe(true);
  });

  it("spawns an agent this machine can launch, and refuses one it cannot", async () => {
    const { run, spawned } = makeCode();
    expect((await run("spawn_agent", { agent: "codex" })).ok).toBe(true);
    expect((await run("spawn_agent", { agent: "Gemini" })).ok).toBe(false);
    expect(spawned).toEqual(["Codex"]);
  });

  it("reports what the agents are doing", async () => {
    const { run } = makeCode();
    expect((await run("agent_status")).speak).toBe("Rowan is working and Release notes is idle.");
    expect((await run("agent_status", { target: "Rowan" })).speak).toBe("Rowan is working.");
  });

  it("reads an agent's recent output for the model to summarise", async () => {
    const { run } = makeCode({ output: { p1: "\u001b[32m✓ 12 tests passed\u001b[0m\r\n" } });
    const result = await run("read_agent_output", { target: "Rowan" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("12 tests passed");
    expect(result.summary).not.toContain("\u001b");
  });

  it("remembers and recalls through the folder's project memory", async () => {
    const { run, written } = makeCode();
    expect((await run("remember", { note: "We ship on Friday." })).ok).toBe(true);
    expect(written[0]).toMatchObject({ projectId: "cp_1", body: "We ship on Friday.", source: "voice" });
    expect((await run("recall", { query: "ship" })).speak).toContain("Ship on Friday");
  });

  // The deps have no way to close a pane at all; the refusal must not act on anything else either.
  it("refuses a close with the ⌘W hint and touches no pane", async () => {
    const { run, sent, focused, spawned } = makeCode();
    for (const name of ["close", "close_all"]) {
      const result = await run(name, { target: "Rowan" });
      expect(result.ok).toBe(false);
      expect(result.speak).toBe(CODE_LIVE_VOICE_CLOSE_REPLY);
    }
    expect({ sent, focused, spawned }).toEqual({ sent: [], focused: [], spawned: [] });
  });

  // Agents flip between working and idle constantly; re-telling the provider each time would be noise.
  it("keeps the context key when only a pane's activity changes", () => {
    const { deps } = makeCode();
    const before = codeLiveVoiceContextKey(deps);
    const panes = deps.getPanes().map((pane) => ({ ...pane, activity: "done" as const }));
    expect(codeLiveVoiceContextKey({ ...deps, getPanes: () => panes })).toBe(before);
    expect(codeLiveVoiceContextKey({ ...deps, getPanes: () => panes.slice(1) })).not.toBe(before);
  });

  describe("close after a spoken yes", () => {
    it("offers close_pane and says how to confirm", () => {
      const { live } = makeCode({ canClose: true });
      expect(live.tools.map((tool) => tool.name)).toContain("close_pane");
      expect(live.instructions).toMatch(/confirm/);
      expect(live.instructions).not.toContain(CODE_LIVE_VOICE_CLOSE_REPLY);
    });

    it("asks first, and closes only when the yes comes back", async () => {
      const { run, closed } = makeCode({ canClose: true });
      const asked = await run("close_pane", { target: "Release notes" });
      expect(asked.speak).toBe("Close Release notes? Say yes to close it.");
      expect(closed).toEqual([]);
      const done = await run("close_pane", { target: "Release notes", confirm: true });
      expect(done.ok).toBe(true);
      expect(closed).toEqual(["p2"]);
    });

    // The model could set confirm on the first call; only Lotus's own question makes a yes count.
    it("treats a confirm with no question asked as the question", async () => {
      const { run, closed } = makeCode({ canClose: true });
      expect((await run("close_pane", { target: "Docs site", confirm: true })).speak).toMatch(/^Close Docs site\?/);
      expect(closed).toEqual([]);
    });

    it("forgets the question once the conversation moves on, or the name changes", async () => {
      const { run, closed } = makeCode({ canClose: true });
      await run("close_pane", { target: "Release notes" });
      await run("agent_status");
      await run("close_pane", { target: "Release notes", confirm: true });
      await run("close_pane", { target: "Docs site", confirm: true });
      expect(closed).toEqual([]);
    });

    // The close guard only asks for unsaved Editor edits: nothing else stands between a misheard yes
    // and a terminal agent killed mid-task.
    it("refuses to close an agent that is working or waiting for the user", async () => {
      const { run, closed } = makeCode({
        canClose: true,
        panes: [
          { id: "p1", name: "Rowan", kind: "terminal", activity: "working" },
          { id: "p2", name: "Remy", kind: "terminal", activity: "needs-you" },
        ],
      });
      const asked = await run("close_pane", { target: "Rowan" });
      expect(asked.ok).toBe(false);
      expect(asked.speak).toBe("Rowan is still working — wait until it finishes, or use ⌘W.");
      expect((await run("close_pane", { target: "Remy" })).ok).toBe(false);
      expect(closed).toEqual([]);
    });

    it("refuses the yes when the agent started working after the question", async () => {
      const panes: CodeVoicePane[] = [{ id: "p1", name: "Rowan", kind: "terminal", activity: "idle" }];
      const { run, closed } = makeCode({ canClose: true, panes });
      await run("close_pane", { target: "Rowan" });
      panes[0] = { ...panes[0], activity: "working" };
      expect((await run("close_pane", { target: "Rowan", confirm: true })).ok).toBe(false);
      expect(closed).toEqual([]);
    });

    it("still never closes everything at once", async () => {
      const { run, closed } = makeCode({ canClose: true });
      expect((await run("close_all", {})).ok).toBe(false);
      expect(closed).toEqual([]);
    });
  });

  it("answers an unknown tool without throwing", async () => {
    const result = await makeCode().run("arrange");
    expect(result.ok).toBe(false);
  });
});
