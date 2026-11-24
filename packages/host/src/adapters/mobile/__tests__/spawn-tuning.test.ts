import { describe, expect, it } from "vitest";

import type { RunnerSummary } from "../../../types/runners.js";
import {
  CLAUDE_EFFORTS,
  CLAUDE_PERMISSIONS,
  CODEX_EFFORTS,
  CODEX_PERMISSIONS,
  permissionModeIds,
  shortCodexLabel,
  tuneRunners,
} from "../spawn-tuning.js";

const claude: RunnerSummary = { id: "claude", name: "Claude", claudeFamily: true, custom: false };
const codex: RunnerSummary = { id: "codex", name: "Codex", claudeFamily: false, custom: false };
const cursor: RunnerSummary = { id: "cursor", name: "Cursor", claudeFamily: false, custom: false };
/** A second-account Claude wrapper — `ccs initech --dangerously-skip-permissions`. */
const hss: RunnerSummary = { id: "custom-hss", name: "HSS", claudeFamily: true, custom: true };
/** The same wrapper, but its command already names a model. */
const acme: RunnerSummary = {
  id: "custom-acme",
  name: "acme",
  claudeFamily: true,
  custom: true,
  pinsTuning: true,
};
/** A command Lotus knows nothing about: `opencode`. */
const opencode: RunnerSummary = { id: "custom-opencode", name: "Opencode", claudeFamily: false, custom: true };

const catalog = () => [
  { slug: "gpt-5.4-codex", displayName: "GPT-5.4 Codex" },
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
];

describe("tuneRunners", () => {
  it("gives claude its aliases with sonnet as the default, and its own effort scale", () => {
    const [tuned] = tuneRunners([claude], () => []);
    // The alias is the label: a tier name cannot age, and the CLI resolves it to the
    // current model of that tier (`claude-models.ts`).
    expect(tuned!.models).toEqual([
      { id: "fable", label: "fable" },
      { id: "opus", label: "opus" },
      { id: "sonnet", label: "sonnet", default: true },
      { id: "haiku", label: "haiku" },
    ]);
    expect(tuned!.efforts).toEqual([...CLAUDE_EFFORTS]);
  });

  it("gives codex the account catalog best-first, the first one default", () => {
    const [tuned] = tuneRunners([codex], catalog);
    expect(tuned!.models).toEqual([
      { id: "gpt-5.4-codex", label: "5.4-codex", default: true },
      { id: "gpt-5.4", label: "5.4" },
    ]);
    expect(tuned!.efforts).toEqual([...CODEX_EFFORTS]);
    // The scales differ, which is the reason they travel per runner.
    expect(tuned!.efforts).not.toEqual(tuneRunners([claude], () => [])[0]!.efforts);
  });

  it("sends no models key at all when the codex catalog is empty — absent, not []", () => {
    const [tuned] = tuneRunners([codex], () => []);
    expect(tuned).not.toHaveProperty("models");
    expect(tuned!.efforts).toEqual([...CODEX_EFFORTS]);
  });

  it("gives a claude-family custom runner the claude knobs — the desktop honours them", () => {
    // The case this used to refuse for every custom runner. `live-agent-spawn.ts` appends
    // `--model`/`--effort` to exactly these, so withholding the picker hid a control the
    // machine would have obeyed.
    const [tuned] = tuneRunners([hss], catalog);
    expect(tuned!.models).toEqual(tuneRunners([claude], () => [])[0]!.models);
    expect(tuned!.efforts).toEqual([...CLAUDE_EFFORTS]);
  });

  it("offers nothing on a custom runner whose command already names a model", () => {
    // Appended after the operator's own flag, the phone's would fight it.
    const [tuned] = tuneRunners([acme], catalog);
    expect(tuned).toEqual(acme);
    expect(tuned).not.toHaveProperty("models");
    expect(tuned).not.toHaveProperty("efforts");
  });

  it("offers nothing on a custom runner that is not claude-family", () => {
    // The original reason, still true: Lotus does not know the flags of a command the
    // operator invented.
    const [tuned] = tuneRunners([opencode], catalog);
    expect(tuned).toEqual(opencode);
    expect(tuned).not.toHaveProperty("models");
  });

  it("a pinned native runner keeps its own tuning too", () => {
    // `extra_flags: "--model opus"` in Settings → Runners is the same collision on
    // `claude` itself, and the registry reports it the same way.
    const pinned = { ...claude, pinsTuning: true };
    expect(tuneRunners([pinned], catalog)[0]).toEqual(pinned);
  });

  it("a host too old to say reads as pinning nothing, so the knobs stay", () => {
    // Absent must not mean "pinned": that would take the picker away from every desktop
    // that has not shipped the field yet.
    expect(tuneRunners([claude], () => [])[0]).toHaveProperty("models");
    expect(tuneRunners([{ ...claude, pinsTuning: false }], () => [])[0]).toHaveProperty("models");
  });

  it("claims no knobs for a runner whose flags Lotus does not know", () => {
    // One thing is still said about it, and it is not a knob: a terminal cell of a runner
    // whose transcript no host reads has no Chat page (`chatInTerminal`).
    expect(tuneRunners([cursor], catalog)[0]).toEqual({ ...cursor, chatInTerminal: false });
  });

  it("does not mutate what the desktop sent", () => {
    const input = [{ ...claude }];
    tuneRunners(input, () => []);
    expect(input[0]).toEqual(claude);
  });
});

describe("shortCodexLabel", () => {
  it("drops the gpt- prefix that every row would share", () => {
    expect(shortCodexLabel("gpt-5.4-codex")).toBe("5.4-codex");
    expect(shortCodexLabel("gpt-5.4")).toBe("5.4");
  });

  it("leaves a slug without the prefix alone", () => {
    expect(shortCodexLabel("o4-mini")).toBe("o4-mini");
  });
});

/**
 * The scale is advertised for the same reason `models` and `efforts` are: so the phone can
 * offer exactly what this machine will honour, and nothing else. These tests guard the
 * *absence* as hard as the presence — a stop offered for `cursor` is a brake with nothing on
 * the other end of it (Pocket ADR-14).
 */
describe("permission scales", () => {
  const tuned = (r: RunnerSummary) => tuneRunners([r], () => [])[0]!;

  it("gives the Claude family Claude's own modes, custom wrappers included", () => {
    expect(tuned(claude).permissions).toEqual(CLAUDE_PERMISSIONS);
    // A second-account `ccs` wrapper runs the same binary, so it takes the same scale.
    expect(tuned(hss).permissions).toEqual(CLAUDE_PERMISSIONS);
  });

  it("gives Codex its own scale, not Claude's wearing different labels", () => {
    expect(tuned(codex).permissions).toEqual(CODEX_PERMISSIONS);
    expect(tuned(codex).permissions).not.toEqual(tuned(claude).permissions);
  });

  it("claims no scale for a runner whose flags Lotus does not know", () => {
    expect(tuned(cursor).permissions).toBeUndefined();
    expect(tuned(opencode).permissions).toBeUndefined();
  });

  /**
   * A launch that already carries its own flags is the one case where the phone's would land
   * after the operator's and fight it — the same reason `pinsTuning` withholds the model.
   */
  it("claims no scale for a runner whose command already pins one", () => {
    expect(tuned(acme).permissions).toBeUndefined();
  });

  it("marks exactly one resting stop per scale", () => {
    for (const scale of [CLAUDE_PERMISSIONS, CODEX_PERMISSIONS]) {
      expect(scale.filter((p) => p.default === true)).toHaveLength(1);
    }
  });

  /**
   * Codex is the only runner whose two spawn paths disagree, and they have disagreed since
   * long before this scale: a PTY Codex bypasses everything, a structured one asks. Losing
   * `defaultHeadless` would rest a headless session on *never asks* — throwing away the only
   * reason it can put an approval in front of the operator at all.
   */
  it("rests headless Codex somewhere other than its PTY default", () => {
    const headless = CODEX_PERMISSIONS.find((p) => p.defaultHeadless === true);
    const pty = CODEX_PERMISSIONS.find((p) => p.default === true);
    expect(headless?.id).toBe("auto");
    expect(pty?.id).toBe("full-access");
  });

  it("will take back every id it advertises", () => {
    const ids = permissionModeIds();
    for (const p of [...CLAUDE_PERMISSIONS, ...CODEX_PERMISSIONS]) expect(ids).toContain(p.id);
    // The pair predates the scale and two other callers still speak only it.
    expect(ids).toContain("safe");
    expect(ids).toContain("yolo");
  });
});

describe("tuneRunners, the headless flag", () => {
  const runners = [
    { id: "claude", name: "Claude", claudeFamily: false, custom: false, pinsTuning: false },
    { id: "codex", name: "Codex", claudeFamily: false, custom: false, pinsTuning: false },
    { id: "cursor", name: "Cursor Agent", claudeFamily: false, custom: false, pinsTuning: false },
    { id: "custom-hss", name: "HSS", claudeFamily: true, custom: true, pinsTuning: false },
    { id: "custom-pinned", name: "acme", claudeFamily: true, custom: true, pinsTuning: true },
  ];
  // The host names them with the label the operator reads; a row already in `runners` keeps
  // the name it already had, so the label only surfaces for a bridge with no terminal runner.
  const flags = (headless: string[]): Array<[string, boolean]> =>
    tuneRunners(runners, () => [], headless.map((id) => ({ id, label: id })))
      .map((r) => [r.id, r.headless ?? false]);

  it("is absent for every runner when the host names none", () => {
    // A host older than this field sends no list, and absent must read as `false` — the same
    // rule `models`/`efforts` follow. Guessing would offer a control the machine cannot honour.
    expect(flags([])).toEqual([
      ["claude", false], ["codex", false], ["cursor", false], ["custom-hss", false], ["custom-pinned", false],
    ]);
  });

  it("marks exactly the native runners the host named", () => {
    expect(flags(["codex", "cursor"])).toEqual([
      ["claude", false], ["codex", true], ["cursor", true], ["custom-hss", false], ["custom-pinned", false],
    ]);
  });

  it("never marks a custom runner, even one named in the list", () => {
    // The bridges are keyed by the native runner id; `ccs acme` is a wrapper with no bridge.
    // The row is still not *added* twice — it is already in the list, wrapper or not.
    expect(flags(["custom-hss"])).toEqual([
      ["claude", false], ["codex", false], ["cursor", false], ["custom-hss", false], ["custom-pinned", false],
    ]);
  });

  it("survives a runner that pins its tuning: no knobs, but still headless", () => {
    const pinned = [{ id: "codex", name: "Codex", claudeFamily: false, custom: false, pinsTuning: true }];
    const [tuned] = tuneRunners(pinned, () => [], [{ id: "codex", label: "Codex" }]);
    expect(tuned).toMatchObject({ id: "codex", headless: true });
    expect(tuned).not.toHaveProperty("models");
    expect(tuned).not.toHaveProperty("permissions");
  });
});

describe("tuneRunners, the account picker", () => {
  const claude = [{ id: "claude", name: "Claude", claudeFamily: false, custom: false, pinsTuning: false }];
  const codex = [{ id: "codex", name: "Codex", claudeFamily: false, custom: false, pinsTuning: false }];

  it("offers nothing when the machine has one account", () => {
    // A picker with a single row reads as a decision the operator has to make and cannot.
    const [tuned] = tuneRunners(claude, () => [], [], [{ id: "default", label: "default" }]);
    expect(tuned).not.toHaveProperty("profiles");
  });

  it("offers nothing when the host named none", () => {
    // A host older than the field, or one that cannot enumerate — told apart by nobody.
    expect(tuneRunners(claude, () => [], [])[0]).not.toHaveProperty("profiles");
  });

  it("offers the accounts once there is a choice", () => {
    const [tuned] = tuneRunners(claude, () => [], [], [
      { id: "default", label: "default" },
      { id: "initech", label: "initech" },
    ]);
    expect(tuned?.profiles?.map((p) => p.id)).toEqual(["default", "initech"]);
  });

  it("claims none for a runner whose accounts these are not", () => {
    // The list is Claude's config dirs. Codex has its own login, and offering Claude's
    // accounts on a Codex row would send a spawn a name its runner never heard of.
    const [tuned] = tuneRunners(codex, () => [], [], [
      { id: "default", label: "default" },
      { id: "initech", label: "initech" },
    ]);
    expect(tuned).not.toHaveProperty("profiles");
  });
});

/**
 * A provider this host can only run *without* a terminal still has to reach the phone.
 *
 * `cursor` is the case that made this matter: it is a bridge and nothing else — there is no
 * PTY runner for it, so it never appeared in `/api/runners`, so the summon sheet never offered
 * it and Chat could not be opened on an agent this machine was perfectly able to run.
 */
describe("tuneRunners, a runner that exists only as a bridge", () => {
  const claude: RunnerSummary = { id: "claude", name: "Claude Code", claudeFamily: false, custom: false, pinsTuning: false };

  it("adds a row for it, marked headless and without a terminal", () => {
    const tuned = tuneRunners([claude], () => [], [
      { id: "claude", label: "Claude Code" },
      { id: "cursor", label: "Cursor Agent" },
    ]);
    const cursor = tuned.find((r) => r.id === "cursor");
    expect(cursor).toMatchObject({ id: "cursor", name: "Cursor Agent", headless: true, terminal: false });
    // Absent on every runner that has one: the phone reads absence as "it has a terminal",
    // which is what every host before this field did.
    expect(tuned.find((r) => r.id === "claude")).not.toHaveProperty("terminal");
  });

  it("claims no knobs for it, the same as any runner whose flags Lotus does not know", () => {
    const [, cursor] = tuneRunners([claude], () => [], [
      { id: "claude", label: "Claude Code" },
      { id: "cursor", label: "Cursor Agent" },
    ]);
    expect(cursor).not.toHaveProperty("models");
    expect(cursor).not.toHaveProperty("permissions");
    expect(cursor).not.toHaveProperty("efforts");
  });

  it("does not duplicate a bridge that already has a terminal runner", () => {
    const tuned = tuneRunners([claude], () => [], [{ id: "claude", label: "Claude Code" }]);
    expect(tuned.map((r) => r.id)).toEqual(["claude"]);
    expect(tuned[0]).toMatchObject({ headless: true });
  });
});

/**
 * The path, not the runner. A terminal codex cell has no Chat page on any host — its only
 * surface is one end-of-turn notify — while the same runner over its bridge streams a whole
 * conversation. Saying so is what lets the phone rest codex on the path that works.
 */
describe("tuneRunners, whether a terminal cell has Chat", () => {
  const runners: RunnerSummary[] = [
    { id: "claude", name: "Claude", claudeFamily: false, custom: false, pinsTuning: false },
    { id: "codex", name: "Codex", claudeFamily: false, custom: false, pinsTuning: false },
    { id: "ccs:work", name: "work", claudeFamily: true, custom: true, pinsTuning: false },
  ];

  it("says no for a runner whose transcript no host reads", () => {
    const tuned = tuneRunners(runners, () => [], [{ id: "codex", label: "Codex" }]);
    expect(tuned.find((r) => r.id === "codex")).toMatchObject({ chatInTerminal: false });
  });

  it("says nothing for the runners that do have one, and nothing about a custom command", () => {
    const tuned = tuneRunners(runners, () => [], []);
    expect(tuned.find((r) => r.id === "claude")).not.toHaveProperty("chatInTerminal");
    // A command the operator invented may be a claude wrapper they did not mark as one.
    // Claiming *no Chat, ever* about it would be a guess; the per-cell answer decides.
    expect(tuned.find((r) => r.id === "ccs:work")).not.toHaveProperty("chatInTerminal");
  });

  it("says it for a bridge-only runner too, which has no terminal to have Chat in", () => {
    const tuned = tuneRunners(runners, () => [], [{ id: "cursor", label: "Cursor" }]);
    expect(tuned.find((r) => r.id === "cursor")).toMatchObject({ terminal: false, chatInTerminal: false });
  });
});

/**
 * A `ccs` account is the claude binary under another config dir, so the Claude bridge runs it
 * with a `profileId` — which means it can have the streaming Chat and the structured
 * permission a native claude cell has. It was excluded until 2026-09-08 on the reasoning that
 * "the bridges are keyed by the native runner id", which was true of the wiring and not of the
 * runner.
 */
describe("tuneRunners, a claude-family runner", () => {
  const runners: RunnerSummary[] = [
    { id: "claude", name: "Claude Code", claudeFamily: false, custom: false, pinsTuning: false },
    { id: "ccs:work", name: "work", claudeFamily: true, custom: true, pinsTuning: false },
    { id: "custom-opencode", name: "opencode", claudeFamily: false, custom: true, pinsTuning: false },
  ];
  const claudeBridge = [{ id: "claude", label: "Claude Code" }];
  const accounts = [{ id: "default", label: "default" }, { id: "work", label: "work" }];

  it("is headless when the claude bridge is here and this machine has that account", () => {
    const tuned = tuneRunners(runners, () => [], claudeBridge, accounts);
    expect(tuned.find((r) => r.id === "ccs:work")).toMatchObject({ headless: true });
  });

  it("is not headless on a machine that does not have that account", () => {
    // The bridge would start, as somebody else. Refusing here is what keeps a cell on the
    // account the operator chose.
    const tuned = tuneRunners(runners, () => [], claudeBridge, [{ id: "default", label: "default" }]);
    expect(tuned.find((r) => r.id === "ccs:work")).not.toHaveProperty("headless");
  });

  it("is not headless when this host has no claude bridge at all", () => {
    const tuned = tuneRunners(runners, () => [], [{ id: "codex", label: "Codex" }], accounts);
    expect(tuned.find((r) => r.id === "ccs:work")).not.toHaveProperty("headless");
  });

  it("leaves a command the operator invented out of it", () => {
    // Lotus does not know what `opencode` speaks, so there is no bridge to route it to.
    const tuned = tuneRunners(runners, () => [], claudeBridge, accounts);
    expect(tuned.find((r) => r.id === "custom-opencode")).not.toHaveProperty("headless");
  });
});
