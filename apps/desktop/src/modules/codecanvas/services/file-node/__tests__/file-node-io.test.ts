import { beforeEach, describe, expect, it, vi } from "vitest";

const editorReadFileFor = vi.fn();
const editorReadFile = vi.fn();
const gitDiff = vi.fn();
let activeRoot: string | null = "/proj";
let activeMachine: { host: string } | null = null;

vi.mock("@/lib/tauri/codespace-editor-dispatch", () => ({
  editorReadFileFor: (...args: unknown[]) => editorReadFileFor(...args),
  editorIndexFilesFor: vi.fn(),
  editorReadFileBytesFor: vi.fn(),
  editorWriteFileFor: vi.fn(),
}));
vi.mock("@/lib/tauri/codespace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  editorReadFile: (...args: unknown[]) => editorReadFile(...args),
}));
vi.mock("@/lib/tauri/codespace-git-dispatch", () => ({
  codespaceGitDiffFileContentFor: (...args: unknown[]) => gitDiff(...args),
}));
vi.mock("@/lib/tauri/editor-watch", () => ({ watchEditorRoot: vi.fn(() => () => {}) }));
vi.mock("../../canvas-active-project", () => ({
  getActiveProjectRootDir: () => activeRoot,
  getActiveProjectLocation: () => activeMachine,
}));

const { fileWatchRegistry, fetchGitBaseline } = await import("../file-node-io");

const ok = { content: "x", mtime: 1, sizeBytes: 1, binary: false, tooLarge: false, encoding: "utf-8" };

beforeEach(() => {
  editorReadFileFor.mockReset().mockResolvedValue(ok);
  editorReadFile.mockReset().mockResolvedValue(ok);
  gitDiff.mockReset().mockResolvedValue({ original: "head text" });
  activeRoot = "/proj";
  activeMachine = null;
});

async function readOnce(path: string) {
  const { activeFileSource } = await import("../file-node-io");
  const source = activeFileSource(path)!;
  await new Promise<void>((resolve) => {
    const stop = fileWatchRegistry.subscribe(source, (view) => {
      if (view.status === "loading") return;
      stop();
      resolve();
    });
  });
}

describe("File Node reads", () => {
  it("reads a file inside the root relative to it, on an SSH board too", async () => {
    activeMachine = { host: "box" };
    await readOnce("/proj/src/a.ts");
    expect(editorReadFileFor).toHaveBeenCalledWith(expect.objectContaining({ host: "box" }), "src/a.ts", expect.objectContaining({ remoteRoot: "/proj" }));
  });

  it("on an SSH board reads a file outside the root from its own folder, not the project root", async () => {
    activeMachine = { host: "box" };
    await readOnce("/etc/hosts");
    expect(editorReadFileFor).toHaveBeenCalledWith(
      expect.objectContaining({ host: "box" }),
      "hosts",
      expect.objectContaining({ remoteRoot: "/etc" }),
    );
  });
});

describe("File Node baseline", () => {
  it("is HEAD's copy: the staged diff's original, so staged edits stay marked", async () => {
    const text = await fetchGitBaseline({ root: "/proj", location: null, path: "/proj/a.ts" });
    expect(text).toBe("head text");
    expect(gitDiff).toHaveBeenCalledWith(null, "/proj/a.ts", "staged", { repoRoot: "/proj" });
  });
});
