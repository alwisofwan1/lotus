import { describe, expect, it } from "vitest";
import type { WorkbenchTab } from "@/modules/codespace/components/types";
import {
  REOPEN_STACK_LIMIT,
  closeTabsInList,
  diffTabId,
  fileTabId,
  hasReopenCandidate,
  keepTab,
  moveTab,
  setTabPinned,
  tabFolderHints,
  tabIndexShortcut,
  openDiffInTabs,
  openFileInTabs,
  popReopenableFile,
  pushClosedFiles,
  tabsInCloseScope,
  openCommitInTabs,
  openGraphInTabs,
  withoutDiffTabs,
} from "../workbench-tab-state";

const file = (path: string): WorkbenchTab => ({ id: fileTabId(path), kind: "file", filePath: path });

describe("openFileInTabs", () => {
  it("activates the tab that already holds the file instead of adding a second one", () => {
    const tabs = [file("/r/a.ts"), file("/r/b.ts")];
    const next = openFileInTabs(tabs, "/r/a.ts");
    expect(next.tabs).toBe(tabs);
    expect(next.activeTabId).toBe(fileTabId("/r/a.ts"));
  });

  it("matches a tab persisted with an old random id by its path", () => {
    const legacy: WorkbenchTab = { id: "3f2a-uuid", kind: "file", filePath: "/r/a.ts" };
    const next = openFileInTabs([legacy], "/r/a.ts");
    expect(next.tabs).toEqual([legacy]);
    expect(next.activeTabId).toBe("3f2a-uuid");
  });

  it("treats a Windows path and its slash form as the same file", () => {
    const next = openFileInTabs([file("C:/r/a.ts")], "C:\\r\\a.ts");
    expect(next.tabs).toHaveLength(1);
  });

  it("appends a new file with an id derived from its path", () => {
    const next = openFileInTabs([file("/r/a.ts")], "/r/c.ts");
    expect(next.tabs.map((tab) => tab.id)).toEqual([fileTabId("/r/a.ts"), fileTabId("/r/c.ts")]);
    expect(next.activeTabId).toBe(fileTabId("/r/c.ts"));
  });
});

describe("tabsInCloseScope", () => {
  const tabs = [file("/r/a"), file("/r/b"), file("/r/c"), file("/r/d")];
  const ids = (list: WorkbenchTab[]) => list.map((tab) => tab.id);

  it("others = every tab but the one clicked", () => {
    expect(ids(tabsInCloseScope(tabs, fileTabId("/r/b"), "others"))).toEqual(ids([tabs[0], tabs[2], tabs[3]]));
  });

  it("right = the tabs after the one clicked", () => {
    expect(ids(tabsInCloseScope(tabs, fileTabId("/r/b"), "right"))).toEqual(ids([tabs[2], tabs[3]]));
  });

  it("one = just that tab", () => {
    expect(ids(tabsInCloseScope(tabs, fileTabId("/r/c"), "one"))).toEqual([fileTabId("/r/c")]);
  });
});

describe("closeTabsInList", () => {
  const tabs = [file("/r/a"), file("/r/b"), file("/r/c"), file("/r/d")];

  it("keeps the active tab when it survives", () => {
    const next = closeTabsInList(tabs, fileTabId("/r/a"), [fileTabId("/r/c")]);
    expect(next.activeTabId).toBe(fileTabId("/r/a"));
    expect(next.tabs).toHaveLength(3);
  });

  it("moves to the nearest surviving tab on the left when the active one closes", () => {
    const next = closeTabsInList(tabs, fileTabId("/r/c"), [fileTabId("/r/c"), fileTabId("/r/b")]);
    expect(next.activeTabId).toBe(fileTabId("/r/a"));
  });

  it("falls back to the first surviving tab when nothing is on the left", () => {
    const next = closeTabsInList(tabs, fileTabId("/r/a"), [fileTabId("/r/a")]);
    expect(next.activeTabId).toBe(fileTabId("/r/b"));
  });

  it("uses the preferred tab when one is given and it survives", () => {
    const next = closeTabsInList(tabs, fileTabId("/r/d"), [fileTabId("/r/c"), fileTabId("/r/d")], fileTabId("/r/b"));
    expect(next.activeTabId).toBe(fileTabId("/r/b"));
  });

  it("leaves no active tab when every tab closes", () => {
    expect(closeTabsInList(tabs, fileTabId("/r/a"), tabs.map((tab) => tab.id))).toEqual({ tabs: [], activeTabId: null });
  });
});

describe("reopen stack", () => {
  it("puts the most recently closed file on top and drops an older copy of it", () => {
    const stack = pushClosedFiles(pushClosedFiles([], ["/r/a", "/r/b"]), ["/r/a"]);
    expect(stack).toEqual(["/r/b", "/r/a"]);
  });

  it(`keeps at most ${REOPEN_STACK_LIMIT} files, dropping the oldest`, () => {
    const paths = Array.from({ length: REOPEN_STACK_LIMIT + 5 }, (_, index) => `/r/${index}`);
    const stack = pushClosedFiles([], paths);
    expect(stack).toHaveLength(REOPEN_STACK_LIMIT);
    expect(stack[0]).toBe("/r/5");
    expect(stack.at(-1)).toBe(`/r/${REOPEN_STACK_LIMIT + 4}`);
  });

  it("pops the newest file that still exists and skips the ones that are gone", async () => {
    const exists = async (path: string) => path !== "/r/gone";
    const result = await popReopenableFile(["/r/a", "/r/gone"], exists, new Set());
    expect(result).toEqual({ path: "/r/a", stack: [] });
  });

  it("skips files that are already open", async () => {
    const result = await popReopenableFile(["/r/a", "/r/b"], async () => true, new Set(["/r/b"]));
    expect(result).toEqual({ path: "/r/a", stack: [] });
  });

  it("counts a file as open whichever slash its path was written with", async () => {
    const result = await popReopenableFile(["C:\\r\\a.ts"], async () => true, ["C:/r/a.ts"]);
    expect(result.path).toBeNull();
  });

  it("has a candidate only while some closed file is not open again", () => {
    expect(hasReopenCandidate([], [])).toBe(false);
    expect(hasReopenCandidate(["/r/a"], ["/r/a"])).toBe(false);
    expect(hasReopenCandidate(["/r/a", "/r/b"], ["/r/a"])).toBe(true);
  });

  it("returns no path when nothing in the stack can be reopened", async () => {
    expect(await popReopenableFile(["/r/gone"], async () => false, new Set())).toEqual({ path: null, stack: [] });
  });
});

const diff = (path: string, target: "staged" | "unstaged" = "unstaged"): WorkbenchTab => ({
  id: diffTabId(path),
  kind: "diff",
  filePath: path,
  target,
});

describe("openDiffInTabs", () => {
  it("adds a diff tab beside the file's editor tab and activates it", () => {
    const tabs = [file("/r/a.ts"), file("/r/b.ts")];
    const next = openDiffInTabs(tabs, "/r/a.ts", "unstaged");
    expect(next.tabs.map((tab) => tab.id)).toEqual([fileTabId("/r/a.ts"), diffTabId("/r/a.ts"), fileTabId("/r/b.ts")]);
    expect(next.activeTabId).toBe(diffTabId("/r/a.ts"));
  });

  it("appends when the file has no editor tab", () => {
    const next = openDiffInTabs([file("/r/b.ts")], "/r/a.ts", "staged");
    expect(next.tabs.at(-1)).toEqual(diff("/r/a.ts", "staged"));
  });

  it("reuses the file's diff tab and switches it to the side that was clicked", () => {
    const tabs = [diff("/r/a.ts", "unstaged"), file("/r/b.ts")];
    const next = openDiffInTabs(tabs, "/r/a.ts", "staged");
    expect(next.tabs).toEqual([diff("/r/a.ts", "staged"), file("/r/b.ts")]);
    expect(next.activeTabId).toBe(diffTabId("/r/a.ts"));
  });

  it("leaves the list alone when the same diff is opened again", () => {
    const tabs = [diff("/r/a.ts")];
    expect(openDiffInTabs(tabs, "/r/a.ts", "unstaged").tabs).toBe(tabs);
  });

  it("keeps a diff tab apart from the file tab of the same path", () => {
    const next = openFileInTabs([diff("/r/a.ts")], "/r/a.ts");
    expect(next.tabs).toHaveLength(2);
    expect(next.activeTabId).toBe(fileTabId("/r/a.ts"));
  });
});

describe("a disk compare tab (Editor Revamp 16)", () => {
  it("is a tab of its own, beside the git diff of the same file", () => {
    const tabs = [file("/r/a.ts"), diff("/r/a.ts", "unstaged")];
    const next = openDiffInTabs(tabs, "/r/a.ts", "disk");
    expect(next.tabs.map((tab) => tab.id)).toEqual([fileTabId("/r/a.ts"), diffTabId("/r/a.ts", "disk"), diffTabId("/r/a.ts")]);
    expect(next.activeTabId).toBe(diffTabId("/r/a.ts", "disk"));
  });

  it("a git side never turns it into a git diff", () => {
    const compare: WorkbenchTab = { id: diffTabId("/r/a.ts", "disk"), kind: "diff", filePath: "/r/a.ts", target: "disk" };
    const next = openDiffInTabs([compare], "/r/a.ts", "staged");
    expect(next.tabs).toHaveLength(2);
    expect(next.tabs[0]).toBe(compare);
  });
});

describe("withoutDiffTabs", () => {
  it("drops diff tabs and keeps the active file tab", () => {
    const next = withoutDiffTabs({ tabs: [file("/r/a.ts"), diff("/r/a.ts")], activeTabId: fileTabId("/r/a.ts") });
    expect(next).toEqual({ tabs: [file("/r/a.ts")], activeTabId: fileTabId("/r/a.ts") });
  });

  it("moves an active diff tab to the nearest tab on its left", () => {
    const next = withoutDiffTabs({
      tabs: [file("/r/a.ts"), file("/r/b.ts"), diff("/r/c.ts")],
      activeTabId: diffTabId("/r/c.ts"),
    });
    expect(next.activeTabId).toBe(fileTabId("/r/b.ts"));
  });

  it("returns the same list when there is no diff tab", () => {
    const tabs = [file("/r/a.ts")];
    expect(withoutDiffTabs({ tabs, activeTabId: null }).tabs).toBe(tabs);
  });
});

describe("preview tabs (LOT2-210)", () => {
  const preview = (path: string): WorkbenchTab => ({ id: fileTabId(path), kind: "file", filePath: path, preview: true });

  it("a preview open replaces the clean preview tab in its place", () => {
    const tabs = [file("/r/a.ts"), preview("/r/b.ts"), file("/r/c.ts")];
    const next = openFileInTabs(tabs, "/r/d.ts", { preview: true });
    expect(next.tabs.map((tab) => tab.kind === "file" && tab.filePath)).toEqual(["/r/a.ts", "/r/d.ts", "/r/c.ts"]);
    expect(next.tabs[1]).toMatchObject({ preview: true });
    expect(next.activeTabId).toBe(fileTabId("/r/d.ts"));
  });

  it("a preview open appends when there is no preview tab", () => {
    const next = openFileInTabs([file("/r/a.ts")], "/r/b.ts", { preview: true });
    expect(next.tabs).toEqual([file("/r/a.ts"), preview("/r/b.ts")]);
  });

  it("a preview tab with unsaved edits is kept, not replaced", () => {
    const dirty: WorkbenchTab = { ...preview("/r/b.ts"), dirty: true } as WorkbenchTab;
    const next = openFileInTabs([dirty], "/r/c.ts", { preview: true });
    expect(next.tabs).toHaveLength(2);
  });

  it("a preview open of a file already in a tab activates it and leaves it as it is", () => {
    const tabs = [file("/r/a.ts"), preview("/r/b.ts")];
    const next = openFileInTabs(tabs, "/r/a.ts", { preview: true });
    expect(next.tabs).toBe(tabs);
    expect(next.activeTabId).toBe(fileTabId("/r/a.ts"));
  });

  it("a normal open of the file in the preview tab keeps it", () => {
    const next = openFileInTabs([preview("/r/b.ts")], "/r/b.ts");
    expect(next.tabs).toEqual([file("/r/b.ts")]);
  });

  it("keepTab turns a preview tab into a normal one and leaves others untouched", () => {
    const tabs = [file("/r/a.ts"), preview("/r/b.ts")];
    expect(keepTab(tabs, fileTabId("/r/b.ts"))).toEqual([file("/r/a.ts"), file("/r/b.ts")]);
    expect(keepTab(tabs, fileTabId("/r/a.ts"))).toBe(tabs);
  });
});

describe("pinned tabs and reordering (LOT2-210)", () => {
  const ids = (tabs: WorkbenchTab[]) => tabs.map((tab) => (tab.kind === "file" ? tab.filePath.slice(3) : tab.id));
  const pinned = (path: string): WorkbenchTab => ({ ...file(path), pinned: true } as WorkbenchTab);

  it("pinning moves the tab to the end of the pinned group at the front", () => {
    const tabs = [pinned("/r/a"), file("/r/b"), file("/r/c")];
    const next = setTabPinned(tabs, fileTabId("/r/c"), true);
    expect(ids(next)).toEqual(["a", "c", "b"]);
    expect(next[1]).toMatchObject({ pinned: true });
  });

  it("pinning a preview tab keeps it", () => {
    const tab: WorkbenchTab = { ...file("/r/a"), preview: true } as WorkbenchTab;
    expect(setTabPinned([tab], tab.id, true)[0]).toEqual({ ...file("/r/a"), pinned: true });
  });

  it("unpinning moves the tab to just after the pinned group", () => {
    const tabs = [pinned("/r/a"), pinned("/r/b"), file("/r/c")];
    const next = setTabPinned(tabs, fileTabId("/r/a"), false);
    expect(ids(next)).toEqual(["b", "a", "c"]);
    expect(next[1]).not.toHaveProperty("pinned");
  });

  it("moveTab puts the tab at the index, counted in the list without it", () => {
    const tabs = [file("/r/a"), file("/r/b"), file("/r/c")];
    expect(ids(moveTab(tabs, fileTabId("/r/a"), 2))).toEqual(["b", "c", "a"]);
    expect(ids(moveTab(tabs, fileTabId("/r/c"), 0))).toEqual(["c", "a", "b"]);
  });

  it("moveTab keeps pinned tabs in front of the others", () => {
    const tabs = [pinned("/r/a"), file("/r/b"), file("/r/c")];
    expect(ids(moveTab(tabs, fileTabId("/r/c"), 0))).toEqual(["a", "c", "b"]);
    expect(ids(moveTab(tabs, fileTabId("/r/a"), 2))).toEqual(["a", "b", "c"]);
  });

  it("moveTab returns the same list when the tab does not move", () => {
    const tabs = [file("/r/a"), file("/r/b")];
    expect(moveTab(tabs, fileTabId("/r/a"), 0)).toBe(tabs);
  });

  it("moveTab keeps a dragged preview tab", () => {
    const tabs = [file("/r/a"), { ...file("/r/b"), preview: true } as WorkbenchTab];
    expect(moveTab(tabs, fileTabId("/r/b"), 0)[0]).toEqual(file("/r/b"));
  });

  it("Close others and Close to the right leave pinned tabs open", () => {
    const tabs = [pinned("/r/a"), file("/r/b"), pinned("/r/c"), file("/r/d")];
    expect(ids(tabsInCloseScope(tabs, fileTabId("/r/b"), "others"))).toEqual(["d"]);
    expect(ids(tabsInCloseScope(tabs, fileTabId("/r/a"), "right"))).toEqual(["b", "d"]);
    expect(ids(tabsInCloseScope(tabs, fileTabId("/r/a"), "one"))).toEqual(["a"]);
  });
});

describe("tabFolderHints (LOT2-210)", () => {
  it("names nothing for tabs whose file names differ", () => {
    expect(tabFolderHints([file("/r/src/a.ts"), file("/r/src/b.ts")]).size).toBe(0);
  });

  it("gives same-name tabs the shortest folder that tells them apart", () => {
    const hints = tabFolderHints([
      file("/r/src/app/index.ts"),
      file("/r/lib/app/index.ts"),
      file("/r/docs/index.ts"),
      file("/r/src/b.ts"),
    ]);
    expect(Object.fromEntries(hints)).toEqual({
      [fileTabId("/r/src/app/index.ts")]: "src/app",
      [fileTabId("/r/lib/app/index.ts")]: "lib/app",
      [fileTabId("/r/docs/index.ts")]: "docs",
    });
  });

  it("does not count a file's own diff tab as a namesake", () => {
    const diff: WorkbenchTab = { id: diffTabId("/r/a.ts", "unstaged"), kind: "diff", filePath: "/r/a.ts", target: "unstaged" };
    expect(tabFolderHints([file("/r/a.ts"), diff]).size).toBe(0);
  });
});

describe("tabIndexShortcut (LOT2-210)", () => {
  const key = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: "", ...init }) as KeyboardEvent;

  it("is ⌃1–⌃8 on a Mac, ⌃9 for the last tab", () => {
    expect(tabIndexShortcut(key({ ctrlKey: true, code: "Digit1" }), "MacIntel")).toBe(0);
    expect(tabIndexShortcut(key({ ctrlKey: true, code: "Digit8" }), "MacIntel")).toBe(7);
    expect(tabIndexShortcut(key({ ctrlKey: true, code: "Digit9" }), "MacIntel")).toBe("last");
  });

  it("leaves ⌘1–9, which jump to a pane, alone", () => {
    expect(tabIndexShortcut(key({ metaKey: true, code: "Digit1" }), "MacIntel")).toBeNull();
    expect(tabIndexShortcut(key({ ctrlKey: true, shiftKey: true, code: "Digit1" }), "MacIntel")).toBeNull();
    expect(tabIndexShortcut(key({ ctrlKey: true, code: "Digit0" }), "MacIntel")).toBeNull();
  });

  it("is Alt+1–9 elsewhere, where Ctrl+1–9 jumps to a pane", () => {
    expect(tabIndexShortcut(key({ altKey: true, code: "Digit2" }), "Win32")).toBe(1);
    expect(tabIndexShortcut(key({ ctrlKey: true, code: "Digit2" }), "Win32")).toBeNull();
  });
});

describe("Git graph tabs", () => {
  const file: WorkbenchTab = { id: "file:/r/a.ts", kind: "file", filePath: "/r/a.ts" };

  it("walks commits in one unpinned tab and keeps a pinned one", () => {
    const first = openCommitInTabs([file], "/r", "aaa", "one");
    const second = openCommitInTabs(first.tabs, "/r", "bbb");
    expect(second.tabs.map((tab) => tab.id)).toEqual(["file:/r/a.ts", "commit:/r:bbb"]);
    const pinned = second.tabs.map((tab) => (tab.kind === "commit" ? { ...tab, pinned: true } : tab));
    expect(openCommitInTabs(pinned, "/r", "ccc").tabs).toHaveLength(3);
  });

  it("opens the wide graph once per repository", () => {
    const once = openGraphInTabs([file], "C:\\r");
    expect(once.activeTabId).toBe("graph:C:/r");
    expect(openGraphInTabs(once.tabs, "C:\\r").tabs).toHaveLength(2);
  });

  it("never saves commit or graph tabs", () => {
    const tabs = openGraphInTabs(openCommitInTabs([file], "/r", "aaa").tabs, "/r").tabs;
    expect(withoutDiffTabs({ tabs, activeTabId: "graph:/r" })).toEqual({ tabs: [file], activeTabId: "file:/r/a.ts" });
  });
});
