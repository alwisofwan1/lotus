import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchTab } from "@/modules/codespace/components/types";
import { useWorkbenchSession, type WorkbenchSessionInput } from "@/modules/codespace/hooks/useWorkbenchSession";
import { clearEditorFileBuffer, getEditorFileBuffer, releaseEditorFileHolder } from "@/modules/codespace/services/editor-file-store";
import { readEditorPreferences } from "@/modules/codespace/services/editor-preferences";
import type { EditorFsChange } from "@/lib/tauri/editor-watch";

const io = vi.hoisted(() => ({
  editorReadFileFor: vi.fn(),
  editorWriteFileFor: vi.fn(),
  codespaceGitStatusFor: vi.fn(),
  watchEditorRoot: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({ isTauri: () => true, editorReadFile: vi.fn(), editorWriteFile: vi.fn() }));
vi.mock("@/lib/tauri/editor-watch", () => ({ watchEditorRoot: io.watchEditorRoot }));
vi.mock("@/lib/tauri/codespace", () => ({
  editorReadFileFor: io.editorReadFileFor,
  editorWriteFileFor: io.editorWriteFileFor,
  codespaceGitStatusFor: io.codespaceGitStatusFor,
  codespaceGitRepoSummaryFor: vi.fn().mockResolvedValue(null),
  codespaceGitDiffFileContentFor: vi.fn(),
}));

const ROOT = "/repo";
const FILE = "/repo/a.ts";
const PREFERENCES = readEditorPreferences(null);
const tab = (path = FILE): WorkbenchTab => ({ id: `tab:${path}`, kind: "file", filePath: path });

function baseInput(overrides: Partial<WorkbenchSessionInput> = {}): WorkbenchSessionInput {
  return {
    holderId: "holder-a",
    location: null,
    rootDir: ROOT,
    enabled: true,
    initialTabs: [tab()],
    initialActiveTabId: tab().id,
    preferences: PREFERENCES,
    ...overrides,
  };
}

let disk: { content: string; mtime: number };
let watcher: (change: EditorFsChange) => void;
const emitChange = (change: { paths: string[]; overflow: boolean }) => watcher({ watchId: "w1", ...change, git: false });

beforeEach(() => {
  releaseEditorFileHolder("holder-a");
  releaseEditorFileHolder("holder-b");
  clearEditorFileBuffer(FILE);
  disk = { content: "one", mtime: 1 };
  io.editorReadFileFor.mockReset();
  io.editorReadFileFor.mockImplementation(async () => ({ ...disk, sizeBytes: disk.content.length, binary: false }));
  io.editorWriteFileFor.mockReset();
  io.editorWriteFileFor.mockImplementation(async (_loc: unknown, _path: string, content: string) => {
    disk = { content, mtime: disk.mtime + 1 };
    return { mtime: disk.mtime };
  });
  io.codespaceGitStatusFor.mockReset();
  io.codespaceGitStatusFor.mockResolvedValue([]);
  io.watchEditorRoot.mockReset();
  io.watchEditorRoot.mockImplementation((_id: string, _root: string, onChange: (change: EditorFsChange) => void) => {
    watcher = onChange;
    return vi.fn();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function opened(overrides: Partial<WorkbenchSessionInput> = {}) {
  const hook = renderHook((props: WorkbenchSessionInput) => useWorkbenchSession(props), {
    initialProps: baseInput(overrides),
  });
  await waitFor(() => expect(hook.result.current.loadedPath).toBe(FILE));
  return hook;
}

describe("useWorkbenchSession", () => {
  it("opens the active tab: content loads and nothing is dirty", async () => {
    const { result } = await opened();
    expect(result.current.activeFilePath).toBe(FILE);
    expect(result.current.content).toBe("one");
    expect(result.current.activeDirty).toBe(false);
  });

  it("edit marks the tab dirty, and save writes once and marks it clean", async () => {
    const { result } = await opened();
    act(() => result.current.handleEditorChange("two"));
    expect(result.current.activeDirty).toBe(true);
    await act(async () => {
      await result.current.handleSave();
    });
    expect(io.editorWriteFileFor).toHaveBeenCalledTimes(1);
    expect(disk.content).toBe("two");
    expect(result.current.activeDirty).toBe(false);
  });

  it("reports tab changes to the owner, with the active id on a switch", async () => {
    const onTabsChange = vi.fn();
    const { result } = await opened({ onTabsChange, initialTabs: [tab(), tab("/repo/b.ts")] });
    act(() => result.current.commitTabs(result.current.tabs, "tab:/repo/b.ts"));
    expect(onTabsChange).toHaveBeenLastCalledWith({ tabs: result.current.tabs, activeTabId: "tab:/repo/b.ts" });
  });

  it("a disk change with no local edits reloads the buffer", async () => {
    const { result } = await opened();
    disk = { content: "three", mtime: 5 };
    await act(async () => emitChange({ paths: [FILE], overflow: false }));
    await waitFor(() => expect(getEditorFileBuffer(FILE)?.content).toBe("three"));
    expect(result.current.content).toBe("three");
    expect(result.current.diskNotice).toBe("a.ts updated on disk");
    expect(result.current.diskConflicts.size).toBe(0);
  });

  describe("a disk change with local edits", () => {
    async function conflicted() {
      const hook = await opened();
      act(() => hook.result.current.handleEditorChange("mine"));
      disk = { content: "theirs", mtime: 9 };
      await act(async () => emitChange({ paths: [FILE], overflow: false }));
      await waitFor(() => expect(hook.result.current.diskConflicts.has(FILE)).toBe(true));
      return hook;
    }

    it("raises the conflict and keeps the edits, writing nothing", async () => {
      const { result } = await conflicted();
      expect(getEditorFileBuffer(FILE)?.content).toBe("mine");
      expect(result.current.activeDirty).toBe(true);
      expect(io.editorWriteFileFor).not.toHaveBeenCalled();
    });

    it("reload takes the disk text and ends the conflict", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const { result } = await conflicted();
      await act(async () => {
        await result.current.reloadFromDisk(FILE);
      });
      expect(result.current.content).toBe("theirs");
      expect(result.current.diskConflicts.size).toBe(0);
      expect(result.current.activeDirty).toBe(false);
    });

    it("overwrite writes the edits over the disk copy and ends the conflict", async () => {
      const { result } = await conflicted();
      await act(async () => {
        await result.current.overwriteDisk(FILE);
      });
      expect(disk.content).toBe("mine");
      expect(result.current.diskConflicts.size).toBe(0);
    });

    it("compare reads the disk copy against the edits", async () => {
      const { result } = await conflicted();
      const diff = await result.current.diskAgainstEdits(FILE);
      expect(diff.original).toBe("theirs");
      expect(diff.modified).toBe("mine");
    });
  });

  it("two holders on one path share a buffer: closing in one keeps the other's edits", async () => {
    const a = await opened();
    const b = await opened({ holderId: "holder-b" });
    act(() => b.result.current.handleEditorChange("shared edit"));
    act(() => a.result.current.closeTab(tab().id));
    expect(getEditorFileBuffer(FILE)?.content).toBe("shared edit");
    await act(async () => {
      await b.result.current.handleSave();
    });
    expect(io.editorWriteFileFor).toHaveBeenCalledTimes(1);
    expect(disk.content).toBe("shared edit");
  });

  describe("auto save", () => {
    it("afterDelay saves the dirty file once the delay passes", async () => {
      const { result } = await opened({ preferences: { ...PREFERENCES, autoSave: "afterDelay" } });
      vi.useFakeTimers();
      act(() => result.current.handleEditorChange("typed"));
      expect(io.editorWriteFileFor).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(io.editorWriteFileFor).toHaveBeenCalledTimes(1);
    });

    it("off never saves by itself", async () => {
      const { result } = await opened();
      vi.useFakeTimers();
      act(() => result.current.handleEditorChange("typed"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(io.editorWriteFileFor).not.toHaveBeenCalled();
    });

    it("onFocusChange saves when the editor blurs", async () => {
      const { result } = await opened({ preferences: { ...PREFERENCES, autoSave: "onFocusChange" } });
      act(() => result.current.handleEditorChange("typed"));
      act(() => result.current.handleEditorBlur());
      await waitFor(() => expect(io.editorWriteFileFor).toHaveBeenCalledTimes(1));
    });
  });

  it("watches the root only while enabled", () => {
    const hook = renderHook((props: WorkbenchSessionInput) => useWorkbenchSession(props), {
      initialProps: baseInput({ enabled: false }),
    });
    expect(io.watchEditorRoot).not.toHaveBeenCalled();
    hook.rerender(baseInput({ enabled: true }));
    expect(io.watchEditorRoot).toHaveBeenCalledWith("holder-a", ROOT, expect.any(Function));
  });
});
