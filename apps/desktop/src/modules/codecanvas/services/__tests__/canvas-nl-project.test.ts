import { describe, expect, it } from "vitest";
import {
  resolveNlIntent,
  type CanvasProjectRef,
  type NlCommandContext,
} from "../canvas-nl-command";
import { localizeConfirmation } from "../voice/localize-confirmation";

const projects: CanvasProjectRef[] = [
  { id: "cp_alpha", name: "Alpha" },
  { id: "cp_beta", name: "Beta" },
  { id: "cp_lotus", name: "lotus-app", aliases: ["Lotus"] },
];

const ctx: NlCommandContext = { roster: [], nodeRefs: [], projects, activeProjectId: "cp_alpha" };

describe("switch_project", () => {
  it("resolves a project name to a switch-project app effect", () => {
    const r = resolveNlIntent({ action: "switch_project", target: "Beta" }, ctx);
    expect(r).toMatchObject({
      effect: { kind: "app", command: { type: "switch-project", projectId: "cp_beta" } },
      destructive: false,
    });
  });

  it("matches a project by alias, not just its display name", () => {
    const r = resolveNlIntent({ action: "switch_project", target: "Lotus" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "app", command: { projectId: "cp_lotus" } } });
  });

  it("tolerates a one-character transcription slip (fuzzy tier)", () => {
    const r = resolveNlIntent({ action: "switch_project", target: "Betaa" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "app", command: { projectId: "cp_beta" } } });
  });

  it("errors when the named project is not open", () => {
    const r = resolveNlIntent({ action: "switch_project", target: "Gamma" }, ctx);
    expect("error" in r && r.error).toContain("Gamma");
    expect("effect" in r).toBe(false);
  });

  it("errors when there are no projects to switch to", () => {
    const r = resolveNlIntent({ action: "switch_project", target: "Beta" }, { roster: [], nodeRefs: [] });
    expect("error" in r).toBe(true);
  });

  it("speaks a natural confirmation using the requested name", () => {
    const r = resolveNlIntent({ action: "switch_project", target: "Beta" }, ctx);
    expect("speak" in r && r.speak).toBe("Switching to Beta");
  });

  it("gives 'already on' feedback when the target is the active project (harmless no-op)", () => {
    const r = resolveNlIntent({ action: "switch_project", target: "Alpha" }, ctx); // active = cp_alpha
    expect("summary" in r && r.summary).toMatch(/already on Alpha/i);
  });
});

describe("switch_project — previous project (anaphora)", () => {
  const ctxPrev: NlCommandContext = { ...ctx, previousProjectId: "cp_beta" };

  it("resolves 'previous' to the previous project id", () => {
    const r = resolveNlIntent({ action: "switch_project", target: "previous" }, ctxPrev);
    expect(r).toMatchObject({ effect: { kind: "app", command: { type: "switch-project", projectId: "cp_beta" } } });
  });

  it("recognizes Indonesian 'sebelumnya'/'proyek tadi' as the previous project", () => {
    expect(resolveNlIntent({ action: "switch_project", target: "sebelumnya" }, ctxPrev)).toMatchObject({ effect: { command: { projectId: "cp_beta" } } });
    expect(resolveNlIntent({ action: "switch_project", target: "proyek tadi" }, ctxPrev)).toMatchObject({ effect: { command: { projectId: "cp_beta" } } });
  });

  it("does NOT treat a real project name containing 'last' as the previous anaphor", () => {
    const projectsWithLast: CanvasProjectRef[] = [...projects, { id: "cp_last", name: "Last Sprint" }];
    const r = resolveNlIntent({ action: "switch_project", target: "Last Sprint" }, { ...ctxPrev, projects: projectsWithLast });
    expect(r).toMatchObject({ effect: { command: { projectId: "cp_last" } } });
  });

  it("errors when asked for the previous project but there is none", () => {
    const r = resolveNlIntent({ action: "switch_project", target: "previous" }, ctx); // no previousProjectId
    expect("error" in r).toBe(true);
  });
});

describe("open_page", () => {
  it("resolves to an open-page app effect for settings", () => {
    const r = resolveNlIntent({ action: "open_page", page: "settings" }, ctx);
    expect(r).toMatchObject({
      effect: { kind: "app", command: { type: "open-page", page: "settings" } },
      destructive: false,
    });
  });

  it("resolves to an open-page app effect for the canvas gallery", () => {
    const r = resolveNlIntent({ action: "open_page", page: "canvases" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "app", command: { type: "open-page", page: "canvases" } } });
  });
});

describe("new_project", () => {
  it("resolves to a new-project app effect", () => {
    const r = resolveNlIntent({ action: "new_project" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "app", command: { type: "new-project" } }, destructive: false });
  });
});

describe("close_project", () => {
  it("closes a named project (destructive)", () => {
    const r = resolveNlIntent({ action: "close_project", target: "Beta" }, ctx);
    expect(r).toMatchObject({
      effect: { kind: "app", command: { type: "close-project", projectId: "cp_beta" } },
      destructive: true,
    });
  });

  it("defaults to closing the active project when no target is given", () => {
    const r = resolveNlIntent({ action: "close_project" }, ctx);
    expect(r).toMatchObject({
      effect: { kind: "app", command: { type: "close-project", projectId: "cp_alpha" } },
      destructive: true,
    });
  });

  it("errors when no target is given and no project is active", () => {
    const r = resolveNlIntent({ action: "close_project" }, { roster: [], nodeRefs: [], projects });
    expect("error" in r).toBe(true);
  });
});

describe("localized voice confirmation", () => {
  const resolved = (i: Parameters<typeof resolveNlIntent>[0]) => {
    const r = resolveNlIntent(i, ctx);
    if ("error" in r) throw new Error(r.error);
    return r;
  };

  it("attaches a language-neutral spoken descriptor for a project switch", () => {
    const r = resolveNlIntent({ action: "switch_project", target: "Beta" }, ctx);
    expect("spoken" in r && r.spoken).toEqual({ kind: "switch_project", target: "Beta" });
  });

  it("renders natural Japanese for the new app intents", () => {
    expect(localizeConfirmation([resolved({ action: "switch_project", target: "Beta" })], "ja")).toContain("Beta");
    expect(localizeConfirmation([resolved({ action: "new_project" })], "ja")).toBeTruthy();
    expect(localizeConfirmation([resolved({ action: "open_page", page: "settings" })], "ja")).toBeTruthy();
  });

  it("keeps English canonical (the summarize output) for the app intents", () => {
    expect(localizeConfirmation([resolved({ action: "switch_project", target: "Beta" })], "en")).toBe("Switching to Beta");
  });
});
