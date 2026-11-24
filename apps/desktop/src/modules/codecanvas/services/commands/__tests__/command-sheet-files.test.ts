import { describe, it, expect, vi } from "vitest";
import { buildFileSheetItems, buildOpenFileBrowseRow, filterCommandSheetItems, buildCommandSheetItems, GROUP_LABEL, GROUP_ORDER } from "../command-sheet-items";

/** ⌘K "Open file…": fuzzy search over the project's files, placing a File Node (plans/canvas-code, S3). */

const files = [
  "/repo/src/auth/session.ts",
  "/repo/src/auth/session.test.ts",
  "/repo/src/ui/Button.tsx",
  "/repo/README.md",
];

describe("opening a file from ⌘K", () => {
  it("offers nothing without a query or without a way to open", () => {
    expect(buildFileSheetItems({ query: "", files, rootDir: "/repo", onBoard: new Set(), onOpenFile: vi.fn() })).toEqual([]);
    expect(buildFileSheetItems({ query: "session", files, rootDir: "/repo", onBoard: new Set(), onOpenFile: undefined })).toEqual([]);
  });

  it("fuzzy-matches the project's files and a row hands that path to the canvas", () => {
    const onOpenFile = vi.fn();
    const rows = buildFileSheetItems({ query: "sess", files, rootDir: "/repo", onBoard: new Set(), onOpenFile });
    expect(GROUP_LABEL.files).toBe("Open file…");
    expect(rows.map((r) => r.title)).toEqual(["session.ts", "session.test.ts"]);
    expect(rows[0]).toMatchObject({ detail: "src/auth", group: "files", tag: "ADD" });
    const action = rows[0]!.action;
    if (action.kind === "custom") action.run();
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/auth/session.ts");
  });

  it("does not offer a file that already has a File Node", () => {
    const rows = buildFileSheetItems({ query: "session", files, rootDir: "/repo", onBoard: new Set(["/repo/src/auth/session.ts"]), onOpenFile: vi.fn() });
    expect(rows.map((r) => r.title)).toEqual(["session.test.ts"]);
  });

  it("caps the rows however many files match", () => {
    const many = Array.from({ length: 500 }, (_, i) => `/repo/src/file-${i}.ts`);
    const rows = buildFileSheetItems({ query: "file", files: many, rootDir: "/repo", onBoard: new Set(), onOpenFile: vi.fn() });
    expect(rows.length).toBeLessThanOrEqual(6);
  });

  it("lands before the send row when searching", () => {
    const catalog = buildCommandSheetItems({ nodes: [], clis: [] });
    const extra = buildFileSheetItems({ query: "button", files, rootDir: "/repo", onBoard: new Set(), onOpenFile: vi.fn() });
    const searched = filterCommandSheetItems(catalog, "button", () => {}, extra);
    expect(searched.map((r) => r.group).slice(-2)).toEqual(["files", "send"]);
  });

  it("browse mode has an Open file… row that keeps the sheet open for typing, in group order", () => {
    const catalog = buildCommandSheetItems({ nodes: [], clis: [] });
    const row = buildOpenFileBrowseRow({ onOpenFile: vi.fn() });
    expect(row).toHaveLength(1);
    expect(row[0].action).toMatchObject({ kind: "custom", keepOpen: true });
    const browse = filterCommandSheetItems(catalog, "", undefined, row);
    const groups = browse.map((r) => r.group);
    expect(groups).toContain("files");
    const order = groups.map((g) => GROUP_ORDER[g]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("offers no browse row without a way to open files", () => {
    expect(buildOpenFileBrowseRow({ onOpenFile: undefined })).toEqual([]);
  });
});
