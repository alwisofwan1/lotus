import { describe, expect, it } from "vitest";
import { createInMemoryCodeCanvasProjectRepository } from "../codecanvas-project-repository";
import type { CodeCanvasProjectSnapshot } from "@/lib/tauri/codecanvas";

function noteSnapshot(snapshot: CodeCanvasProjectSnapshot): CodeCanvasProjectSnapshot {
  return {
    ...snapshot,
    nodes: [{ type: "note", id: "n1", position: { x: 0, y: 0 }, size: { w: 300, h: 200 }, content: "note" }],
    edges: [],
    terminalCounter: 2,
  };
}

describe("CodeCanvas project repository", () => {
  it("opens a Canvas Project once per normalized root directory", async () => {
    const repo = createInMemoryCodeCanvasProjectRepository();
    const first = await repo.openProject("/tmp/demo//");
    const second = await repo.openProject("/tmp/demo");
    const index = await repo.getIndex();

    expect(second.id).toBe(first.id);
    expect(second.rootDir).toBe("/tmp/demo");
    expect(index.projects).toHaveLength(1);
    expect(index.activeProjectId).toBe(first.id);
  });

  it("round-trips active project snapshots", async () => {
    const repo = createInMemoryCodeCanvasProjectRepository();
    const project = await repo.openProject("/repo");
    await repo.saveProject(noteSnapshot(project));

    const loaded = await repo.loadProject(project.id);

    expect(loaded?.nodes).toHaveLength(1);
    expect(loaded?.terminalCounter).toBe(2);
  });

  it("closes only the selected Canvas Project", async () => {
    const repo = createInMemoryCodeCanvasProjectRepository();
    const first = await repo.openProject("/repo/a");
    const second = await repo.openProject("/repo/b");

    const index = await repo.closeProject(second.id);

    expect(index.projects.map((p) => p.id)).toEqual([first.id]);
    expect(index.activeProjectId).toBe(first.id);
    expect(await repo.loadProject(second.id)).toBeNull();
  });
});
