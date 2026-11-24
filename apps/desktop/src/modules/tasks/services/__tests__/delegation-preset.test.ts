import { describe, expect, it } from "vitest";
import {
  prepareDelegationPreset,
  resumeCommand,
  startCommand,
  supportsChosenSession,
  resolveDelegationPresets,
  type DelegationPreset,
} from "@/modules/tasks/services/delegation-preset";
import type { ClaudeSettings } from "@/modules/settings/types";

const withPresets = (delegation: unknown) => ({ delegation }) as unknown as ClaudeSettings;

const preset = (overrides: Partial<DelegationPreset> = {}): DelegationPreset => ({
  id: "p1",
  name: "Claude",
  agent: "claude",
  args: "",
  instructions: "",
  ...overrides,
});

describe("reading presets out of settings", () => {
  it("reads the ones somebody defined", () => {
    const presets = resolveDelegationPresets(
      withPresets({ presets: [{ id: "p1", name: "Claude · yolo", agent: "claude", args: "--yolo" }] }),
    );

    expect(presets).toEqual([
      { id: "p1", name: "Claude · yolo", agent: "claude", args: "--yolo", instructions: "" },
    ]);
  });

  it("treats a missing key, a null file and a wrong type as no presets", () => {
    // This file is edited by people and by older builds. None of that is worth throwing over.
    expect(resolveDelegationPresets(undefined)).toEqual([]);
    expect(resolveDelegationPresets(null)).toEqual([]);
    expect(resolveDelegationPresets({} as ClaudeSettings)).toEqual([]);
    expect(resolveDelegationPresets(withPresets({ presets: "nope" }))).toEqual([]);
  });

  it("drops an entry that could not spawn anything", () => {
    // A preset without an agent is a button that would fail the moment it is pressed.
    const presets = resolveDelegationPresets(
      withPresets({
        presets: [
          { id: "ok", name: "Fine", agent: "codex" },
          { id: "bad", name: "No agent" },
          { id: "worse", agent: "claude" },
        ],
      }),
    );

    expect(presets.map((p) => p.id)).toEqual(["ok"]);
  });
});

describe("making a preset", () => {
  it("refuses one that names nothing", () => {
    expect(prepareDelegationPreset({ name: "  ", agent: "claude", args: "", instructions: "" }, [])).toEqual(
      { ok: false, reason: "empty-name" },
    );
  });

  it("refuses one that would spawn nothing", () => {
    expect(prepareDelegationPreset({ name: "Nameless", agent: " ", args: "", instructions: "" }, [])).toEqual(
      { ok: false, reason: "no-agent" },
    );
  });

  /*
    A preset is chosen from a menu by its name, so two with the same name are two rows nobody can
    tell apart — and the wrong one costs a real process and real money.
  */
  it("refuses a name already taken, whatever the casing", () => {
    expect(
      prepareDelegationPreset({ name: "claude", agent: "claude", args: "", instructions: "" }, [preset()]),
    ).toEqual({ ok: false, reason: "duplicate-name" });
  });

  it("gives a new preset an id of its own", () => {
    const made = prepareDelegationPreset(
      { name: "Codex high", agent: "codex", args: " --reasoning high ", instructions: " be terse " },
      [preset()],
    );

    expect(made.ok && made.preset).toMatchObject({
      name: "Codex high",
      agent: "codex",
      args: "--reasoning high",
      instructions: "be terse",
    });
    expect(made.ok && made.preset.id).toBeTruthy();
  });
});

describe("editing a preset", () => {
  it("keeps its id, so the sidebar row and every recorded dispatch still point at it", () => {
    const edited = prepareDelegationPreset(
      { name: "Claude · careful", agent: "claude", args: "", instructions: "" },
      [preset()],
      "p1",
    );
    expect(edited.ok && edited.preset.id).toBe("p1");
  });

  it("does not call its own name a duplicate", () => {
    const edited = prepareDelegationPreset(
      { name: preset().name, agent: "codex", args: "", instructions: "" },
      [preset()],
      "p1",
    );
    expect(edited.ok).toBe(true);
  });

  it("still refuses another preset's name", () => {
    const other = preset({ id: "p2", name: "Codex" });
    expect(
      prepareDelegationPreset({ name: "codex", agent: "codex", args: "", instructions: "" }, [preset(), other], "p1"),
    ).toEqual({ ok: false, reason: "duplicate-name" });
  });
});

describe("sessions a preset can be resumed into", () => {
  it("only claims what the agent can actually do", () => {
    // `--session-id` is Claude's. A Resume button on a codex pane would be a promise nothing keeps.
    expect(supportsChosenSession(preset({ agent: "claude" }))).toBe(true);
    expect(supportsChosenSession(preset({ agent: "codex" }))).toBe(false);
    expect(supportsChosenSession(preset({ agent: "cat" }))).toBe(false);
  });

  /*
    `ccs` is a profile switcher around Claude — `ccs <profile> [claude-args...]`, which is its own
    documented shape — so everything Claude accepts reaches it. Without this, the one preset
    somebody actually uses here gets no session and no way back into it.
  */
  it("counts a wrapper that forwards Claude's own arguments", () => {
    expect(supportsChosenSession(preset({ agent: "ccs", args: "acme" }))).toBe(true);
  });

  it("refuses the wrapper when no profile was named", () => {
    // `ccs` alone is the CLI's own help, not an agent, and a session flag would be a usage error.
    expect(supportsChosenSession(preset({ agent: "ccs", args: "" }))).toBe(false);
  });

  it("reads a ccs profile written into the agent field, and does not take a flag for one", () => {
    // How the real preset that surfaced this is saved: the profile inside `agent`.
    expect(supportsChosenSession(preset({ agent: "ccs acme", args: "--dangerously-skip-permissions" }))).toBe(true);
    expect(startCommand(preset({ agent: "ccs acme", args: "--dangerously-skip-permissions" }), "9f3c")).toBe(
      "ccs acme --dangerously-skip-permissions --session-id 9f3c",
    );
    expect(supportsChosenSession(preset({ agent: "ccs", args: "--help" }))).toBe(false);
    expect(supportsChosenSession(preset({ agent: "codex", args: "claude" }))).toBe(false);
  });

  it("keeps the wrapper's profile ahead of the session flag", () => {
    expect(
      startCommand(preset({ agent: "ccs", args: "acme --dangerously-skip-permissions" }), "9f3c"),
    ).toBe("ccs acme --dangerously-skip-permissions --session-id 9f3c");
  });

  it("starts the session under the id we chose, keeping the preset's own flags", () => {
    const command = startCommand(
      preset({ agent: "claude", args: "--dangerously-skip-permissions" }),
      "9f3c1a2b",
    );

    expect(command).toBe("claude --dangerously-skip-permissions --session-id 9f3c1a2b");
  });

  it("walks back into it with the same flags", () => {
    const command = resumeCommand(
      preset({ agent: "claude", args: "--dangerously-skip-permissions" }),
      "9f3c1a2b",
    );

    expect(command).toBe("claude --dangerously-skip-permissions --resume 9f3c1a2b");
  });

  it("hands an agent that cannot take an id its plain command", () => {
    expect(startCommand(preset({ agent: "codex", args: "--high" }), "9f3c")).toBe("codex --high");
  });
});

describe("a preset's Claude account (issues/07)", () => {
  it("keeps an account on a Claude preset, through saving and reading back", () => {
    const made = prepareDelegationPreset({ name: "HSS", agent: "claude", args: "", instructions: "", account: " hss " }, []);
    expect(made.ok && made.preset.account).toBe("hss");
    const read = resolveDelegationPresets(withPresets({ presets: [made.ok ? made.preset : null] }));
    expect(read[0].account).toBe("hss");
  });

  it("drops it on any other agent, which has no Claude config to point at", () => {
    const made = prepareDelegationPreset({ name: "Codex", agent: "codex", args: "", instructions: "", account: "hss" }, []);
    expect(made.ok && "account" in made.preset).toBe(false);
  });
});
