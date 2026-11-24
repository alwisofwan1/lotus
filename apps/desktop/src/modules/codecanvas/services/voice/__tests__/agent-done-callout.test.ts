import { describe, expect, it } from "vitest";
import { buildFinishCallout as buildFinishCalloutForPersona } from "../agent-done-callout";

describe("buildFinishCallout with a persona pool", () => {
  const pools = { en: ["{name} has finished, sir.", "That's {name} done, sir."] };

  it("speaks the persona's own phrasing instead of the built-in line", () => {
    expect(buildFinishCalloutForPersona("Nova", "en", 0, undefined, pools)).toBe("Nova has finished, sir.");
  });

  it("rotates through the persona pool so back-to-back finishes don't repeat", () => {
    expect(buildFinishCalloutForPersona("Nova", "en", 1, undefined, pools)).toBe("That's Nova done, sir.");
    expect(buildFinishCalloutForPersona("Nova", "en", 2, undefined, pools)).toBe("Nova has finished, sir.");
  });

  it("falls back to the built-in pool when the persona has no phrasing for that language", () => {
    expect(buildFinishCalloutForPersona("Nova", "ja", 0, undefined, pools)).toBe("Novaが完了しました。");
    expect(buildFinishCalloutForPersona("Nova", "en", 0, undefined, {})).toBe("Nova is done.");
  });

  it("keeps repo attribution on a cross-project finish rather than dropping it for the persona line", () => {
    // The persona pool has no {repo} slot. Preferring it here would silently lose WHERE the work
    // landed — the whole point of the cross-project callout.
    expect(buildFinishCalloutForPersona("Nova", "en", 0, "lotus", pools)).toContain("lotus");
  });
});
import type { VoiceOutputSettings } from "@/lib/tauri-api";
import {
  agentCalloutsEnabled,
  buildFinishCallout,
  computeAnnounceVisibility,
  isHookCapableRunner,
  rectsIntersect,
  resolveFinishCallout,
  shouldAnnounceAgentFinish,
} from "../agent-done-callout";

// Alerts on (the default) unless a test turns them off: Off silences visible finishes too (#184).
const settings = (over: Partial<VoiceOutputSettings>): VoiceOutputSettings => ({
  speakReplies: true,
  agentDoneCallouts: true,
  wakeOnFinish: false,
  ...over,
});

describe("resolveFinishCallout", () => {
  const roster = [{ id: "a1", name: "Rowan" }, { id: "a2", name: "Sage" }];

  it("returns the callout for a known visible agent when wakeOnFinish is on", () => {
    const out = resolveFinishCallout("a1", { roster, visible: true, settings: settings({ wakeOnFinish: true }) });
    expect(out).toBe("Rowan is done.");
  });

  it("returns null for a visible finish when wakeOnFinish is off", () => {
    expect(resolveFinishCallout("a1", { roster, visible: true, settings: settings({ wakeOnFinish: false }) })).toBeNull();
  });

  it("gates a background finish on agentDoneCallouts", () => {
    expect(resolveFinishCallout("a2", { roster, visible: false, settings: settings({ agentDoneCallouts: true }) })).toBe("Sage is done.");
    expect(resolveFinishCallout("a2", { roster, visible: false, settings: settings({ agentDoneCallouts: false }) })).toBeNull();
  });

  it("ignores a paneId that is not a known agent (e.g. a non-canvas terminal)", () => {
    expect(resolveFinishCallout("unknown", { roster, visible: false, settings: settings({ agentDoneCallouts: true }) })).toBeNull();
  });

  it("threads the persona's callout pool through to the phrasing", () => {
    const out = resolveFinishCallout("a1", {
      roster,
      visible: true,
      settings: settings({ wakeOnFinish: true }),
      personaPools: { en: ["{name} has finished, sir."] },
    });

    expect(out).toBe("Rowan has finished, sir.");
  });

  it("threads the language and rotation variant through to the phrasing", () => {
    const ja = resolveFinishCallout("a1", { roster, visible: true, settings: settings({ wakeOnFinish: true }), language: "ja-JP" });
    expect(ja).toBe("Rowanが完了しました。");
    const v0 = resolveFinishCallout("a1", { roster, visible: true, settings: settings({ wakeOnFinish: true }), variant: 0 });
    const v1 = resolveFinishCallout("a1", { roster, visible: true, settings: settings({ wakeOnFinish: true }), variant: 1 });
    expect(v0).not.toBe(v1); // consecutive finishes sound different
  });
});

describe("resolveFinishCallout — cross-project repo attribution", () => {
  const roster = [
    { id: "a1", name: "Rowan", projectId: "projB" },
    { id: "a2", name: "Sage", projectId: "projA" },
  ];
  const resolveProjectLabel = (id: string) => ({ projA: "orbit-vault", projB: "lotus" }[id] ?? null);

  it("names the repo when the finish is in a DIFFERENT project than the one on screen", () => {
    // Viewing projB; Sage (projA) finishes in the background → the callout tells me which repo.
    const out = resolveFinishCallout("a2", {
      roster,
      visible: false,
      settings: settings({ agentDoneCallouts: true }),
      activeProjectId: "projB",
      resolveProjectLabel,
    });
    expect(out).toBe("Sage is done in orbit-vault.");
  });

  it("stays bare (no repo phrase) when the finish is in the project on screen", () => {
    const out = resolveFinishCallout("a1", {
      roster,
      visible: true,
      settings: settings({ wakeOnFinish: true }),
      activeProjectId: "projB",
      resolveProjectLabel,
    });
    expect(out).toBe("Rowan is done."); // same project → today's phrasing, no repo tail
  });

  it("resolves an UNMOUNTED cross-project agent via the fallback identity (survives the switch)", () => {
    // The node for projA unmounted on the project switch, so it is gone from the live roster —
    // the fallback identity is what keeps the finish announceable instead of silently dropped.
    const out = resolveFinishCallout("gone", {
      roster,
      fallbackIdentity: { id: "gone", name: "Atlas", projectId: "projA" },
      visible: false,
      settings: settings({ agentDoneCallouts: true }),
      activeProjectId: "projB",
      resolveProjectLabel,
    });
    expect(out).toBe("Atlas is done in orbit-vault.");
  });

  it("falls back to the bare line when the project label can't be resolved", () => {
    const out = resolveFinishCallout("a2", {
      roster,
      visible: false,
      settings: settings({ agentDoneCallouts: true }),
      activeProjectId: "projB",
      resolveProjectLabel: () => null,
    });
    expect(out).toBe("Sage is done.");
  });

  it("names the repo when no active project is known, so out-of-project surfaces stay unambiguous", () => {
    const out = resolveFinishCallout("a2", {
      roster,
      visible: false,
      settings: settings({ agentDoneCallouts: true }),
      activeProjectId: null,
      resolveProjectLabel,
    });
    expect(out).toBe("Sage is done in orbit-vault.");
  });

  it("uses project-scoped hook pane ids so same node ids across projects do not steal the callout", () => {
    const out = resolveFinishCallout("canvas:projA:agent-1", {
      roster: [{ id: "agent-1", hookPaneId: "canvas:projB:agent-1", name: "Nara", projectId: "projB" }],
      fallbackIdentity: { id: "agent-1", hookPaneId: "canvas:projA:agent-1", name: "Nara", projectId: "projA" },
      visible: false,
      settings: settings({ agentDoneCallouts: true }),
      activeProjectId: "projB",
      resolveProjectLabel,
    });
    expect(out).toBe("Nara is done in orbit-vault.");
  });

  it("can infer the project from a scoped hook pane id when older identity data lacks projectId", () => {
    const out = resolveFinishCallout("canvas:projA:agent-1", {
      roster: [],
      fallbackIdentity: { id: "agent-1", hookPaneId: "canvas:projA:agent-1", name: "Nara" },
      visible: false,
      settings: settings({ agentDoneCallouts: true }),
      activeProjectId: "projB",
      resolveProjectLabel,
    });
    expect(out).toBe("Nara is done in orbit-vault.");
  });

  it("names the repo in Japanese too", () => {
    const out = resolveFinishCallout("a2", {
      roster,
      visible: false,
      settings: settings({ agentDoneCallouts: true }),
      activeProjectId: "projB",
      resolveProjectLabel,
      language: "ja-JP",
    });
    expect(out).toContain("orbit-vault");
    expect(out).toContain("Sage");
    expect(out).toContain("完了"); // still a natural Japanese finish line
  });
});

describe("buildFinishCallout — with a repo label", () => {
  it("appends the repo naturally in English", () => {
    expect(buildFinishCallout("Rowan", "en-US", 0, "orbit-vault")).toBe("Rowan is done in orbit-vault.");
  });
  it("weaves the repo into the Japanese line", () => {
    expect(buildFinishCallout("Rowan", "ja-JP", 0, "orbit-vault")).toBe("orbit-vaultのRowanが完了しました。");
  });
  it("ignores a blank repo label (stays bare)", () => {
    expect(buildFinishCallout("Rowan", "en-US", 0, "   ")).toBe("Rowan is done.");
  });
  it("rotates cross-project phrasings by variant too", () => {
    const v0 = buildFinishCallout("Rowan", "en-US", 0, "lotus");
    const v1 = buildFinishCallout("Rowan", "en-US", 1, "lotus");
    expect(v0).not.toBe(v1);
    for (const v of [v0, v1]) expect(v).toContain("lotus");
  });
});

describe("shouldAnnounceAgentFinish", () => {
  it("gates a background finish on agentDoneCallouts", () => {
    expect(shouldAnnounceAgentFinish(false, settings({ agentDoneCallouts: true }))).toBe(true);
    expect(shouldAnnounceAgentFinish(false, settings({ agentDoneCallouts: false }))).toBe(false);
  });
  it("gates a visible finish on wakeOnFinish", () => {
    expect(shouldAnnounceAgentFinish(true, settings({ wakeOnFinish: true }))).toBe(true);
    // Visible finishes are NOT announced by agentDoneCallouts alone.
    expect(shouldAnnounceAgentFinish(true, settings({ agentDoneCallouts: true, wakeOnFinish: false }))).toBe(false);
  });
  it("stays silent on screen too when the alert is Off (#184)", () => {
    expect(shouldAnnounceAgentFinish(true, settings({ agentDoneCallouts: false, wakeOnFinish: true }))).toBe(false);
    expect(shouldAnnounceAgentFinish(true, settings({ agentDoneAlert: "off", wakeOnFinish: true }))).toBe(false);
    expect(shouldAnnounceAgentFinish(false, settings({ agentDoneCallouts: false, agentDoneAlert: "sound" }))).toBe(true);
  });
});

describe("agentCalloutsEnabled", () => {
  it("is true unless the alert is Off, false when unset", () => {
    expect(agentCalloutsEnabled(undefined)).toBe(false);
    expect(agentCalloutsEnabled(settings({}))).toBe(true);
    expect(agentCalloutsEnabled(settings({ agentDoneCallouts: false, wakeOnFinish: true }))).toBe(false);
    expect(agentCalloutsEnabled(settings({ agentDoneAlert: "sound" }))).toBe(true);
    expect(agentCalloutsEnabled(settings({ agentDoneAlert: "off" }))).toBe(false);
  });
});

describe("buildFinishCallout", () => {
  it("builds a short line, falling back to 'Agent'", () => {
    expect(buildFinishCallout("Rowan")).toBe("Rowan is done.");
    expect(buildFinishCallout("  ")).toBe("Agent is done.");
  });

  it("answers Indonesian voice-input in English — Indonesian is dropped as a reply language", () => {
    // The callout follows the configured voice-input language, but Indonesian TTS reads unnatural,
    // so an Indonesian-configured user hears the English callout (not Indonesian).
    expect(buildFinishCallout("Rowan", "id-ID")).toBe("Rowan is done.");
    expect(buildFinishCallout("  ", "id")).toBe("Agent is done.");
    expect(buildFinishCallout("Rowan", "en-US")).toBe("Rowan is done.");
  });

  it("speaks Japanese when the STT language says Japanese", () => {
    expect(buildFinishCallout("Rowan", "ja-JP")).toBe("Rowanが完了しました。");
    expect(buildFinishCallout("  ", "ja")).toBe("エージェントが完了しました。");
  });

  it("rotates phrasings deterministically by variant — repetition is what reads as robotic", () => {
    const v0 = buildFinishCallout("Rowan", "ja-JP", 0);
    const v1 = buildFinishCallout("Rowan", "ja-JP", 1);
    const v2 = buildFinishCallout("Rowan", "ja-JP", 2);
    expect(v0).toBe("Rowanが完了しました。"); // variant 0 keeps today's phrase (backward compatible)
    expect(new Set([v0, v1, v2]).size).toBe(3); // consecutive finishes sound different
    for (const v of [v1, v2]) expect(v).toContain("Rowan");
    // Deterministic: the same variant always yields the same phrase (testable, no Math.random).
    expect(buildFinishCallout("Rowan", "ja-JP", 1)).toBe(v1);
  });

  it("wraps the variant index modulo the pool size (a long session never runs out)", () => {
    const pool = new Set(Array.from({ length: 12 }, (_, i) => buildFinishCallout("Rowan", "en-US", i)));
    expect(pool.size).toBeGreaterThanOrEqual(3);
    const poolSize = pool.size;
    expect(buildFinishCallout("Rowan", "en-US", poolSize)).toBe(buildFinishCallout("Rowan", "en-US", 0));
  });
});

describe("rectsIntersect", () => {
  const vp = { left: 0, top: 0, right: 1000, bottom: 800 };
  it("detects overlap with the viewport", () => {
    expect(rectsIntersect({ left: 100, top: 100, right: 300, bottom: 300 }, vp)).toBe(true);
  });
  it("rejects a node fully off-screen", () => {
    expect(rectsIntersect({ left: -400, top: 100, right: -100, bottom: 300 }, vp)).toBe(false);
    expect(rectsIntersect({ left: 1100, top: 100, right: 1400, bottom: 300 }, vp)).toBe(false);
  });
});

describe("isHookCapableRunner", () => {
  it("treats built-in claude and codex as hook-capable (stop hook / notify installed)", () => {
    expect(isHookCapableRunner("claude")).toBe(true);
    expect(isHookCapableRunner("codex")).toBe(true);
  });

  it("treats cursor and unknown/custom runners as fallback-only", () => {
    expect(isHookCapableRunner("cursor")).toBe(false);
    expect(isHookCapableRunner("my-custom")).toBe(false);
    expect(isHookCapableRunner(undefined)).toBe(false);
  });

  it("a custom runner flagged claude-family fires the same claude stop hook", () => {
    expect(isHookCapableRunner("my-custom", true)).toBe(true);
  });
});

describe("computeAnnounceVisibility", () => {
  it("a node on-viewport in a focused, visible window is 'visible' (wakeOnFinish policy)", () => {
    expect(computeAnnounceVisibility(true, true, false)).toBe(true);
  });

  it("an off-viewport node is background regardless of window state", () => {
    expect(computeAnnounceVisibility(false, true, false)).toBe(false);
  });

  it("a blurred window makes even an on-viewport node 'background' — the away-from-app case the callouts exist for", () => {
    expect(computeAnnounceVisibility(true, false, false)).toBe(false);
  });

  it("a hidden/minimized window is always background", () => {
    expect(computeAnnounceVisibility(true, true, true)).toBe(false);
  });
});
