import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/lib/tauri/runtime", () => ({
  tauriInvoke: mocks.invoke,
}));

import {
  codecanvasCloseProject,
  codecanvasGetIndex,
  codecanvasOpenProject,
  codecanvasRenameProject,
  codecanvasSaveProject,
  codecanvasLoadCollaborationRecord,
  codecanvasSaveCollaborationRecord,
  codecanvasMemoryArchive,
  codecanvasMemoryList,
  codecanvasMemorySearch,
  codecanvasMemoryWrite,
  codecanvasSaveNoteAsset,
  codecanvasImportNoteAssetPath,
  codecanvasListNoteAssets,
  codecanvasReadNoteAsset,
  codecanvasDeleteNoteAsset,
  codecanvasPruneUnusedNoteAssets,
  codecanvasRevealNoteAsset,
  codecanvasRevealNoteAssetFolder,
  type CodeCanvasProjectSnapshot,
} from "@/lib/tauri/codecanvas";

describe("CodeCanvas Tauri adapter", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("loads project index through the dedicated command", async () => {
    await codecanvasGetIndex();
    expect(mocks.invoke).toHaveBeenCalledWith("codecanvas_get_index");
  });

  it("opens a project by root directory", async () => {
    await codecanvasOpenProject("/repo");
    expect(mocks.invoke).toHaveBeenCalledWith("codecanvas_open_project", {
      rootDir: "/repo",
      location: null,
    });
  });

  it("names the machine when the project is not on this one", async () => {
    await codecanvasOpenProject("/srv/devbox/api", { kind: "ssh", host: "devbox-vps", user: "root" });
    expect(mocks.invoke).toHaveBeenCalledWith("codecanvas_open_project", {
      rootDir: "/srv/devbox/api",
      location: { kind: "ssh", host: "devbox-vps", user: "root" },
    });
  });

  it("saves project snapshots without reshaping graph data", async () => {
    const snapshot: CodeCanvasProjectSnapshot = {
      id: "cp_1", rootDir: "/repo", alias: null, position: 0, updatedAt: 1, lastOpenedAt: 1,
      nodes: [{ type: "note", id: "n1", position: { x: 0, y: 0 }, size: { w: 1, h: 1 }, content: "x" }],
      edges: [], terminalCounter: 3,
    };
    await codecanvasSaveProject(snapshot);
    expect(mocks.invoke).toHaveBeenCalledWith("codecanvas_save_project", { snapshot });
  });

  it("stores and reads collaboration records through project-backed commands", async () => {
    const payload = { runId: "swarm-task:task_1", messages: [{ id: "m1" }] };
    await codecanvasSaveCollaborationRecord("cp_1", "swarm-task:task_1", "mailbox", payload);
    await codecanvasLoadCollaborationRecord("cp_1", "swarm-task:task_1", "mailbox");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "codecanvas_save_collaboration_record", {
      projectId: "cp_1",
      runId: "swarm-task:task_1",
      kind: "mailbox",
      payload,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "codecanvas_load_collaboration_record", {
      projectId: "cp_1",
      runId: "swarm-task:task_1",
      kind: "mailbox",
    });
  });

  it("uses project-backed CodeCanvas memory commands without reshaping records", async () => {
    const write = {
      projectId: "cp_1",
      scopeKind: "project",
      kind: "decision",
      body: "Use SQLite project memory",
      source: "human",
      actorKind: "human",
      idempotencyKey: "decision-sqlite",
    };
    const list = { projectId: "cp_1", includeArchived: false, limit: 20 };
    const search = { projectId: "cp_1", query: "sqlite memory", kinds: ["decision"] };

    await codecanvasMemoryWrite(write);
    await codecanvasMemoryList(list);
    await codecanvasMemorySearch(search);
    await codecanvasMemoryArchive("cp_1", "mem_1");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "codecanvas_memory_write", { input: write });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "codecanvas_memory_list", { query: list });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "codecanvas_memory_search", { query: search });
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, "codecanvas_memory_archive", { projectId: "cp_1", itemId: "mem_1" });
  });

  it("stores and reads Note Assets through dedicated commands", async () => {
    await codecanvasSaveNoteAsset({ projectId: "cp_1", originalName: "shot.png", mime: "image/png", base64: "aGk=" });
    await codecanvasImportNoteAssetPath({ projectId: "cp_1", path: "/tmp/shot.png" });
    await codecanvasListNoteAssets("cp_1");
    await codecanvasReadNoteAsset("asset_1");
    await codecanvasDeleteNoteAsset("asset_1", true);
    await codecanvasPruneUnusedNoteAssets("cp_1");
    await codecanvasRevealNoteAsset("asset_1");
    await codecanvasRevealNoteAssetFolder("cp_1");
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "codecanvas_save_note_asset", {
      input: { projectId: "cp_1", originalName: "shot.png", mime: "image/png", base64: "aGk=" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "codecanvas_import_note_asset_path", { input: { projectId: "cp_1", path: "/tmp/shot.png" } });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "codecanvas_list_note_assets", { projectId: "cp_1" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, "codecanvas_read_note_asset", { assetId: "asset_1" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(5, "codecanvas_delete_note_asset", { assetId: "asset_1", force: true });
    expect(mocks.invoke).toHaveBeenNthCalledWith(6, "codecanvas_prune_unused_note_assets", { projectId: "cp_1" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(7, "codecanvas_reveal_note_asset", { assetId: "asset_1" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(8, "codecanvas_reveal_note_asset_folder", { projectId: "cp_1" });
  });

  it("renames and closes projects by project id", async () => {
    await codecanvasRenameProject("cp_1", "Alias");
    await codecanvasCloseProject("cp_1");
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "codecanvas_rename_project", { projectId: "cp_1", alias: "Alias" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "codecanvas_close_project", { projectId: "cp_1" });
  });
});
