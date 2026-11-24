import { describe, expect, it } from "vitest";

import { draftInFolder, type Draft } from "../ChatStart";

const draft = (patch: Partial<Draft>): Draft => ({
  runner: "claude",
  model: null,
  provider: null,
  effort: null,
  cwd: "/home",
  permissionMode: "acceptEdits",
  machine: null,
  ...patch,
});

describe("a Code pane's start draft (07d)", () => {
  it("keeps the remembered agent and mode, in the pane's folder", () => {
    expect(draftInFolder(draft({ runner: "codex", model: "gpt" }), "/w/lotus")).toEqual(
      draft({ runner: "codex", model: "gpt", cwd: "/w/lotus" }),
    );
  });

  it("does not start on a remembered API model, which reads no files", () => {
    expect(draftInFolder(draft({ runner: "api", model: "deepseek", provider: "p1" }), "/w/lotus")).toEqual(
      draft({ cwd: "/w/lotus" }),
    );
  });

  it("drops a remembered SSH machine: a pane's folder is on this Mac", () => {
    const remote = { host: "devbox-vps", user: null, port: null, workspaceId: "w1" };
    expect(draftInFolder(draft({ machine: remote, cwd: "/srv/app" }), "/w/lotus")).toEqual(draft({ cwd: "/w/lotus" }));
  });
});
