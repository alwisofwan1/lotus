import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { brainstormBoardFolder, brainstormFrameKey, brainstormLaunchCommand, planBrainstormFrame } from "../canvas-factory-brainstorm";

const factory = (id: string, repo: string, issue: number | string, frameId?: string): Node => ({
  id, type: "factory", position: { x: 0, y: 0 }, data: { repo, issue, title: "Fix login", ...(frameId ? { frameId } : {}) },
});
const frame = (id: string, taskKey?: string): Node => ({
  id, type: "frame", position: { x: 0, y: 0 }, data: { title: "F", ...(taskKey ? { taskKey } : {}) },
});
const run = { repo: "Owner/Repo", issue: 7, title: "Fix login" };

describe("planBrainstormFrame", () => {
  it("makes the run's Frame around its Factory node, named and keyed by the issue", () => {
    expect(planBrainstormFrame([factory("n1", "owner/repo", 7)], run)).toEqual({
      kind: "create",
      factoryNodeId: "n1",
      title: "#7 Fix login",
      taskKey: "factory:owner/repo#7",
    });
  });

  it("asks for the Factory node when the board has none", () => {
    expect(planBrainstormFrame([factory("n1", "owner/repo", 8)], run)).toMatchObject({ kind: "create", factoryNodeId: null });
  });

  it("joins the Frame the Factory node is already in", () => {
    const nodes = [frame("f1"), factory("n1", "owner/repo", 7, "f1")];
    expect(planBrainstormFrame(nodes, run)).toEqual({ kind: "join", frameId: "f1", factoryNodeId: "n1", title: "#7 Fix login" });
  });

  it("finds the run's Frame again by its key, also with the Factory node gone", () => {
    expect(planBrainstormFrame([frame("f2", brainstormFrameKey(run))], run)).toMatchObject({ kind: "join", frameId: "f2", factoryNodeId: null });
  });

  it("keys a Notion ticket by its id", () => {
    expect(brainstormFrameKey({ repo: "o/r", issue: "TKT-12" })).toBe("factory:o/r#TKT-12");
  });
});

describe("brainstormLaunchCommand", () => {
  it("passes the whole prompt as one argument, never typed into the terminal", () => {
    const prompt = `Brainstorm "quoted" $HOME && rm -rf x\n${"x".repeat(4000)}`;
    expect(brainstormLaunchCommand(prompt)).toEqual(["claude", prompt]);
  });
});

describe("brainstormBoardFolder", () => {
  it("keeps a repo in a subfolder on the canvas on screen that holds it", () => {
    expect(brainstormBoardFolder("/w/acme-main/acme-web", "/w/acme-main/", [])).toBe("/w/acme-main/");
  });

  it("uses the canvas whose folder holds the checkout most closely", () => {
    expect(brainstormBoardFolder("/w/main/front", "/elsewhere", ["/w", "/w/main", "/w/mainline"])).toBe("/w/main");
  });

  it("does not take a sibling with the same prefix for a parent", () => {
    expect(brainstormBoardFolder("/w/main-2/front", "/w/main", ["/w/main"])).toBe("/w/main-2/front");
  });

  it("opens a canvas for the checkout when none holds it", () => {
    expect(brainstormBoardFolder("/repo", "/other", ["/x"])).toBe("/repo");
  });
});
