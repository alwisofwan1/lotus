import { describe, it, expect } from "vitest";
import {
  buildCompletionToast,
  classifyCompletionScope,
  normalizeToastPosition,
  selectToastStackView,
  upsertCompletionToast,
  BACKGROUND_PROJECT_DURATION_MS,
  DEFAULT_MAX_VISIBLE_TOASTS,
  DEFAULT_TOAST_POSITION,
  SAME_PROJECT_DURATION_MS,
  TOAST_POSITIONS,
  toastStackHeightRem,
  type CompletionToast,
  type ToastPosition,
} from "../agent-completion-toast";

const label = (projectId: string): string | null =>
  ({ p1: "orbit-vault", p2: "lotus-remote" } as Record<string, string>)[projectId] ?? null;

describe("normalizeToastPosition", () => {
  it("defaults to bottom-right", () => {
    expect(DEFAULT_TOAST_POSITION).toBe("bottom-right");
  });

  it("lists every supported position", () => {
    expect(TOAST_POSITIONS).toEqual([
      "bottom-right",
      "bottom-left",
      "top-right",
      "top-left",
      "bottom-center",
    ]);
  });

  it("accepts each valid position unchanged", () => {
    for (const pos of TOAST_POSITIONS) {
      expect(normalizeToastPosition(pos)).toBe(pos);
    }
  });

  it("falls back to the default for junk, legacy, or missing values", () => {
    const junk: unknown[] = [undefined, null, "", "center", "left", 42, {}, [], "BOTTOM-RIGHT"];
    for (const value of junk) {
      expect(normalizeToastPosition(value)).toBe(DEFAULT_TOAST_POSITION);
    }
  });

  it("narrows unknown input to the ToastPosition type", () => {
    const pos: ToastPosition = normalizeToastPosition("top-left");
    expect(pos).toBe("top-left");
  });
});

describe("classifyCompletionScope", () => {
  it("is background when the agent's project differs from the active one", () => {
    expect(classifyCompletionScope("p1", "active")).toBe("background");
  });
  it("is same when the agent's project matches the active one", () => {
    expect(classifyCompletionScope("active", "active")).toBe("same");
  });
  it("is same when the agent has no project (mirrors the voice policy)", () => {
    expect(classifyCompletionScope(undefined, "active")).toBe("same");
    expect(classifyCompletionScope(null, null)).toBe("same");
  });
});

describe("buildCompletionToast", () => {
  const base = { eventId: "e1", agentId: "n1", agentName: "Nara", now: 1000 };

  it("builds a same-project toast with the short duration and a resolved label", () => {
    const t = buildCompletionToast({
      ...base,
      agentProjectId: "active",
      activeProjectId: "active",
      resolveProjectLabel: () => "orchids-agent-teams",
    });
    expect(t.scope).toBe("same");
    expect(t.durationMs).toBe(SAME_PROJECT_DURATION_MS);
    expect(t.projectLabel).toBe("orchids-agent-teams");
    expect(t.agentName).toBe("Nara");
    expect(t.id).toBe("e1");
    expect(t.dedupeKey).toBe("n1");
    expect(t.createdAt).toBe(1000);
  });

  it("builds a background-project toast with the long duration and repo label", () => {
    const t = buildCompletionToast({
      ...base,
      agentProjectId: "p1",
      activeProjectId: "active",
      resolveProjectLabel: label,
    });
    expect(t.scope).toBe("background");
    expect(t.durationMs).toBe(BACKGROUND_PROJECT_DURATION_MS);
    expect(t.projectLabel).toBe("orbit-vault");
    expect(t.agentProjectId).toBe("p1");
  });

  it("has a null label when no human label resolves (never leaks the raw project id / hash)", () => {
    // Mirrors the voice channel, which stays bare rather than speaking an internal id.
    const t = buildCompletionToast({ ...base, agentProjectId: "cp_9f3a1c0000e21", activeProjectId: "active", resolveProjectLabel: () => null });
    expect(t.projectLabel).toBeNull();
    expect(t.scope).toBe("background");
  });

  it("has a null label when there is no project context at all", () => {
    const t = buildCompletionToast({ ...base, agentProjectId: null, activeProjectId: null });
    expect(t.projectLabel).toBeNull();
    expect(t.scope).toBe("same");
  });

  it("defaults a blank name to \"Agent\"", () => {
    expect(buildCompletionToast({ ...base, agentName: "   " }).agentName).toBe("Agent");
    expect(buildCompletionToast({ ...base, agentName: undefined }).agentName).toBe("Agent");
  });

  it("uses the eventId as the dedupe key when no agentId is given", () => {
    expect(buildCompletionToast({ ...base, agentId: undefined }).dedupeKey).toBe("e1");
  });
});

function toast(over: Partial<CompletionToast> & { id: string; dedupeKey: string }): CompletionToast {
  return {
    agentId: over.dedupeKey,
    agentName: "A",
    agentProjectId: undefined,
    projectLabel: null,
    scope: "same",
    durationMs: SAME_PROJECT_DURATION_MS,
    createdAt: 0,
    ...over,
  };
}

describe("upsertCompletionToast", () => {
  it("appends a new toast to the end", () => {
    const list = [toast({ id: "a", dedupeKey: "k1" })];
    const next = upsertCompletionToast(list, toast({ id: "b", dedupeKey: "k2" }));
    expect(next.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("replaces an existing toast with the same dedupe key and moves it to newest (latest-wins)", () => {
    const list = [toast({ id: "a", dedupeKey: "k1" }), toast({ id: "b", dedupeKey: "k2" })];
    const next = upsertCompletionToast(list, toast({ id: "a2", dedupeKey: "k1" }));
    expect(next.map((t) => t.id)).toEqual(["b", "a2"]);
    expect(next).toHaveLength(2);
  });

  it("does not mutate the input list", () => {
    const list = [toast({ id: "a", dedupeKey: "k1" })];
    upsertCompletionToast(list, toast({ id: "b", dedupeKey: "k2" }));
    expect(list.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("selectToastStackView", () => {
  const make = (n: number) => Array.from({ length: n }, (_, i) => toast({ id: `t${i}`, dedupeKey: `k${i}`, createdAt: i }));

  it("shows everything when at or below the cap", () => {
    const view = selectToastStackView(make(3));
    expect(view.visible.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
    expect(view.collapsed).toEqual([]);
    expect(view.collapsedCount).toBe(0);
    expect(view.collapsedPreview).toBeNull();
  });

  it("keeps the newest (cap - 1) as cards and folds the rest into a pile", () => {
    const view = selectToastStackView(make(5)); // cap 3 → 2 cards + pile of 3
    expect(view.visible.map((t) => t.id)).toEqual(["t3", "t4"]);
    expect(view.collapsed.map((t) => t.id)).toEqual(["t0", "t1", "t2"]); // oldest→newest, for expansion
    expect(view.collapsedCount).toBe(3);
    expect(view.collapsedPreview?.id).toBe("t2"); // newest of the folded
  });

  it("honors a custom cap", () => {
    const view = selectToastStackView(make(4), 2); // 1 card + pile of 3
    expect(view.visible.map((t) => t.id)).toEqual(["t3"]);
    expect(view.collapsedCount).toBe(3);
  });

  it("is empty for an empty list", () => {
    const view = selectToastStackView([]);
    expect(view.visible).toEqual([]);
    expect(view.collapsedCount).toBe(0);
  });

  it("exposes a sane default cap", () => {
    expect(DEFAULT_MAX_VISIBLE_TOASTS).toBe(3);
  });
});

describe("toastStackHeightRem", () => {
  it("collapsed: one card height plus a peek sliver per visible back layer (max 3 layers)", () => {
    expect(toastStackHeightRem(1, false)).toBe("2.5rem");
    expect(toastStackHeightRem(2, false)).toBe("3.0625rem"); // 2.5 + 1×0.5625
    expect(toastStackHeightRem(3, false)).toBe("3.625rem"); // 2.5 + 2×0.5625
    expect(toastStackHeightRem(6, false)).toBe("3.625rem"); // deeper cards hide, height stays
  });

  it("open: full column — every card plus the gaps between", () => {
    expect(toastStackHeightRem(1, true)).toBe("2.5rem");
    expect(toastStackHeightRem(3, true)).toBe("8.5rem"); // 3×2.5 + 2×0.5
  });

  it("is zero for an empty stack", () => {
    expect(toastStackHeightRem(0, false)).toBe("0rem");
    expect(toastStackHeightRem(0, true)).toBe("0rem");
  });
});
