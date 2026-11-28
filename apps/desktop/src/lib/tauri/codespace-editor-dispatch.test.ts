import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
}));

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: mocks.isTauri,
  tauriInvoke: mocks.invoke,
}));

import {
  editorCreateDirectoryFor,
  editorCreateFileFor,
  editorDeleteEntryFor,
  editorIndexFilesFor,
  editorListDirectoryFor,
  editorListEntriesFor,
  editorReadFileFor,
  editorRenameEntryFor,
  editorRevealEntry,
  editorWriteFileFor,
  type CodeSpaceStoredWorkspaceLocation,
} from "@/lib/tauri/codespace";
const SSH_LOCATION: CodeSpaceStoredWorkspaceLocation = {
  kind: "ssh",
  host: "devbox-vps",
  user: "alwi",
  port: 2222,
  remoteCwd: "/home/alwi/project",
};

const LOCAL_LOCATION: CodeSpaceStoredWorkspaceLocation = {
  kind: "local",
  cwd: "/Users/alwi/project",
};

describe("editorReadFileFor", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ content: "", mtime: 0, sizeBytes: 0, binary: false });
  });

  it("dispatches to editor_read_file_ssh with target+remoteCwd for ssh workspaces", async () => {
    await editorReadFileFor(SSH_LOCATION, "src/main.rs");

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("editor_read_file_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project",
      relativePath: "src/main.rs",
    });
  });

  it("dispatches to editor_read_file with absolute path for local workspaces", async () => {
    await editorReadFileFor(LOCAL_LOCATION, "src/main.rs");

    expect(mocks.invoke).toHaveBeenCalledWith("editor_read_file", {
      path: "/Users/alwi/project/src/main.rs",
    });
  });

  it("falls back to localRoot override when location is null", async () => {
    await editorReadFileFor(null, "x.txt", { localRoot: "/tmp/repo" });

    expect(mocks.invoke).toHaveBeenCalledWith("editor_read_file", {
      path: "/tmp/repo/x.txt",
    });
  });

  it("throws when neither location nor localRoot is supplied", async () => {
    await expect(editorReadFileFor(null, "x.txt")).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("treats ssh location with empty remoteCwd as not-ssh and requires localRoot", async () => {
    const incomplete: CodeSpaceStoredWorkspaceLocation = {
      kind: "ssh",
      host: "devbox-vps",
      remoteCwd: "",
    };
    await expect(editorReadFileFor(incomplete, "x.txt")).rejects.toThrow();
  });
});

describe("editorListEntriesFor", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue([]);
  });

  it("dispatches to editor_list_entries_ssh for ssh workspaces", async () => {
    await editorListEntriesFor(SSH_LOCATION, 4);

    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project",
      maxDepth: 4,
    });
  });

  it("uses remoteRoot override for ssh tree listing", async () => {
    await editorListEntriesFor(SSH_LOCATION, 4, { remoteRoot: "/home/alwi/project/packages/app" });

    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project/packages/app",
      maxDepth: 4,
    });
  });

  it("ignores a non-absolute remoteRoot override (e.g. \"~\") and falls back to location.remoteCwd", async () => {
    await editorListEntriesFor(SSH_LOCATION, 4, { remoteRoot: "~" });

    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project",
      maxDepth: 4,
    });
  });

  it("ignores a relative remoteRoot override and falls back to location.remoteCwd", async () => {
    await editorListEntriesFor(SSH_LOCATION, 4, { remoteRoot: "src/packages/app" });

    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project",
      maxDepth: 4,
    });
  });

  it("uses remoteRoot as the ssh root when the persisted location has no remoteCwd", async () => {
    const incomplete: CodeSpaceStoredWorkspaceLocation = {
      kind: "ssh",
      host: "devbox-vps",
      user: "alwi",
      port: 2222,
    };

    await editorListEntriesFor(incomplete, 4, { remoteRoot: "/home/alwi/project" });

    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project",
      maxDepth: 4,
    });
  });

  it("dispatches to editor_list_entries for local workspaces", async () => {
    await editorListEntriesFor(LOCAL_LOCATION, 2);

    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries", {
      root: "/Users/alwi/project",
      maxDepth: 2,
    });
  });

  it("returns empty list when location is null and no localRoot", async () => {
    const result = await editorListEntriesFor(null);
    expect(result).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("normalizes user and port absent-fields to null over the wire", async () => {
    const minimal: CodeSpaceStoredWorkspaceLocation = {
      kind: "ssh",
      host: "host-only",
      remoteCwd: "/srv",
    };
    await editorListEntriesFor(minimal);

    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries_ssh", {
      target: { host: "host-only", user: null, port: null },
      remoteCwd: "/srv",
      maxDepth: null,
    });
  });

  it("serves cached SSH listings within the cache window", async () => {
    mocks.invoke.mockResolvedValueOnce([{ path: "/home/alwi/project/cache/src", kind: "directory" }]);

    const first = await editorListEntriesFor(SSH_LOCATION, 4, {
      cache: true,
      remoteRoot: "/home/alwi/project/cache",
    });
    const second = await editorListEntriesFor(SSH_LOCATION, 4, {
      cache: true,
      remoteRoot: "/home/alwi/project/cache",
    });

    expect(first).toEqual(second);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("bypasses cached SSH listings when force is requested", async () => {
    mocks.invoke
      .mockResolvedValueOnce([{ path: "/home/alwi/project/cache-force/src", kind: "directory" }])
      .mockResolvedValueOnce([{ path: "/home/alwi/project/cache-force/src/app.ts", kind: "file" }]);

    await editorListEntriesFor(SSH_LOCATION, 4, {
      cache: true,
      remoteRoot: "/home/alwi/project/cache-force",
    });
    const refreshed = await editorListEntriesFor(SSH_LOCATION, 4, {
      cache: true,
      force: true,
      remoteRoot: "/home/alwi/project/cache-force",
    });

    expect(refreshed).toEqual([{ path: "/home/alwi/project/cache-force/src/app.ts", kind: "file" }]);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});

describe("editorWriteFileFor", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ mtime: 0 });
  });

  it("dispatches to editor_write_file_ssh with mtime null when omitted", async () => {
    await editorWriteFileFor(SSH_LOCATION, "src/main.rs", "hello");

    expect(mocks.invoke).toHaveBeenCalledWith("editor_write_file_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project",
      relativePath: "src/main.rs",
      content: "hello",
      expectedMtime: null,
    });
  });

  it("forwards expectedMtime when provided", async () => {
    await editorWriteFileFor(SSH_LOCATION, "src/main.rs", "hello", 12345);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "editor_write_file_ssh",
      expect.objectContaining({ expectedMtime: 12345 }),
    );
  });

  it("dispatches to editor_write_file with absolute path for local workspaces", async () => {
    await editorWriteFileFor(LOCAL_LOCATION, "src/main.rs", "hello", 7);

    expect(mocks.invoke).toHaveBeenCalledWith("editor_write_file", {
      path: "/Users/alwi/project/src/main.rs",
      content: "hello",
      expectedMtime: 7,
    });
  });

  it("throws when neither location nor localRoot is supplied", async () => {
    await expect(editorWriteFileFor(null, "x.txt", "")).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("editorCreateFileFor / editorCreateDirectoryFor / editorDeleteEntryFor", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ path: "/repo/x" });
  });

  it("dispatches create-file SSH command for ssh workspaces", async () => {
    await editorCreateFileFor(SSH_LOCATION, "src/new.rs");

    expect(mocks.invoke).toHaveBeenCalledWith("editor_create_file_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project",
      relativePath: "src/new.rs",
    });
  });

  it("dispatches create-file LOCAL command for local workspaces (passes root, not joined)", async () => {
    await editorCreateFileFor(LOCAL_LOCATION, "src/new.rs");

    expect(mocks.invoke).toHaveBeenCalledWith("editor_create_file", {
      root: "/Users/alwi/project",
      relativePath: "src/new.rs",
    });
  });

  it("dispatches create-directory SSH command for ssh workspaces", async () => {
    await editorCreateDirectoryFor(SSH_LOCATION, "src/new");

    expect(mocks.invoke).toHaveBeenCalledWith(
      "editor_create_directory_ssh",
      expect.objectContaining({ relativePath: "src/new" }),
    );
  });

  it("dispatches delete SSH command for ssh workspaces", async () => {
    await editorDeleteEntryFor(SSH_LOCATION, "obsolete.rs");

    expect(mocks.invoke).toHaveBeenCalledWith(
      "editor_delete_entry_ssh",
      expect.objectContaining({ relativePath: "obsolete.rs" }),
    );
  });

  it("rejects when location is null and no localRoot", async () => {
    await expect(editorCreateFileFor(null, "x")).rejects.toThrow();
    await expect(editorCreateDirectoryFor(null, "x")).rejects.toThrow();
    await expect(editorDeleteEntryFor(null, "x")).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("editorListDirectoryFor", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue([]);
  });

  it("lists one local folder: that folder as the root, depth 0 (its direct children)", async () => {
    await editorListDirectoryFor(LOCAL_LOCATION, "/Users/alwi/project/src/deep");
    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries", {
      root: "/Users/alwi/project/src/deep",
      maxDepth: 0,
    });
  });

  it("lists one remote folder: find counts its depth from 1, so it asks for 1", async () => {
    await editorListDirectoryFor(SSH_LOCATION, "/home/alwi/project/src/deep");
    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project/src/deep",
      maxDepth: 1,
    });
  });

  it("does not serve a folder from the cache after a forced refresh", async () => {
    await editorListDirectoryFor(LOCAL_LOCATION, "/Users/alwi/project/a", { cache: true });
    await editorListDirectoryFor(LOCAL_LOCATION, "/Users/alwi/project/a", { cache: true });
    await editorListDirectoryFor(LOCAL_LOCATION, "/Users/alwi/project/a", { cache: true, force: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps only direct children when the remote list returns a whole subtree (git ls-files)", async () => {
    mocks.invoke.mockResolvedValueOnce([
      { path: "/home/alwi/project/src/a.ts", kind: "file" },
      { path: "/home/alwi/project/src/lib/b.ts", kind: "file" },
      { path: "/home/alwi/project/src/lib/deep/c.ts", kind: "file" },
      { path: "/home/alwi/project/src/ui", kind: "directory" },
      { path: "/home/alwi/project/src/ui/x.tsx", kind: "file" },
    ]);

    const entries = await editorListDirectoryFor(SSH_LOCATION, "/home/alwi/project/src");

    expect(entries).toEqual([
      { path: "/home/alwi/project/src/a.ts", kind: "file" },
      { path: "/home/alwi/project/src/lib", kind: "directory" },
      { path: "/home/alwi/project/src/ui", kind: "directory" },
    ]);
  });

  it("lists a local Windows folder whose entries Rust spells with backslashes", async () => {
    mocks.invoke.mockResolvedValueOnce([
      { path: "C:\\proj\\src", kind: "directory" },
      { path: "C:\\proj\\README.md", kind: "file" },
    ]);

    const entries = await editorListDirectoryFor(LOCAL_LOCATION, "C:\\proj");

    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries", { root: "C:\\proj", maxDepth: 0 });
    expect(entries).toEqual([
      { path: "C:\\proj\\src", kind: "directory" },
      { path: "C:\\proj\\README.md", kind: "file" },
    ]);
  });

  it("lists a WSL share opened from Windows, spelled with forward slashes", async () => {
    const root = "//wsl.localhost/Ubuntu/home/dev/acme-web";
    mocks.invoke.mockResolvedValueOnce([
      { path: `${root}/src`, kind: "directory" },
      { path: `${root}/package.json`, kind: "file" },
    ]);

    const entries = await editorListDirectoryFor(LOCAL_LOCATION, `${root}/`);

    expect(entries.map((entry) => entry.path)).toEqual([`${root}/src`, `${root}/package.json`]);
  });

  it("never takes a sibling that only shares the folder's name as a prefix", async () => {
    mocks.invoke.mockResolvedValueOnce([
      { path: "C:\\proj\\a.ts", kind: "file" },
      { path: "C:\\proj-old\\b.ts", kind: "file" },
    ]);

    const entries = await editorListDirectoryFor(LOCAL_LOCATION, "C:\\proj");

    expect(entries).toEqual([{ path: "C:\\proj\\a.ts", kind: "file" }]);
  });
});

describe("editorIndexFilesFor", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("asks Rust for the whole local index and joins its relative paths back onto the root", async () => {
    mocks.invoke.mockResolvedValueOnce({ files: ["a.ts", "src/b.ts"], truncated: false });
    const index = await editorIndexFilesFor(LOCAL_LOCATION, "/Users/alwi/project/");
    expect(mocks.invoke).toHaveBeenCalledWith("editor_index_files", { root: "/Users/alwi/project/" });
    expect(index.files).toEqual(["/Users/alwi/project/a.ts", "/Users/alwi/project/src/b.ts"]);
  });

  it("joins a Windows index with backslashes, as the tree and tabs spell those paths", async () => {
    mocks.invoke.mockResolvedValueOnce({ files: ["a.ts", "src/b.ts"], truncated: false });
    const index = await editorIndexFilesFor(LOCAL_LOCATION, "C:\\proj");
    expect(index.files).toEqual(["C:\\proj\\a.ts", "C:\\proj\\src\\b.ts"]);
  });

  it("uses the remote list, deep, files only", async () => {
    mocks.invoke.mockResolvedValueOnce([
      { path: "/home/alwi/project/src", kind: "directory" },
      { path: "/home/alwi/project/src/a.ts", kind: "file" },
    ]);
    const index = await editorIndexFilesFor(SSH_LOCATION, "/home/alwi/project");
    expect(mocks.invoke).toHaveBeenCalledWith("editor_list_entries_ssh", expect.objectContaining({ maxDepth: 10, remoteCwd: "/home/alwi/project" }));
    expect(index).toEqual({ files: ["/home/alwi/project/src/a.ts"], truncated: false });
  });

  it("skips heavy folders remotely too, like the local walk, and keeps dot-folders", async () => {
    mocks.invoke.mockResolvedValueOnce([
      { path: "/home/alwi/p-hidden/.venv/lib/x.py", kind: "file" },
      { path: "/home/alwi/p-hidden/.env", kind: "file" },
      { path: "/home/alwi/p-hidden/.github/ci.yml", kind: "file" },
      { path: "/home/alwi/p-hidden/web/node_modules/z.js", kind: "file" },
      { path: "/home/alwi/p-hidden/src/a.ts", kind: "file" },
    ]);
    const index = await editorIndexFilesFor(SSH_LOCATION, "/home/alwi/p-hidden");
    expect(index.files).toEqual([
      "/home/alwi/p-hidden/.env",
      "/home/alwi/p-hidden/.github/ci.yml",
      "/home/alwi/p-hidden/src/a.ts",
    ]);
  });

  it("caps the remote index like the local one and says so", async () => {
    const many = Array.from({ length: 200_005 }, (_, i) => ({ path: `/home/alwi/p-cap/f${i}.ts`, kind: "file" as const }));
    mocks.invoke.mockResolvedValueOnce(many);
    const index = await editorIndexFilesFor(SSH_LOCATION, "/home/alwi/p-cap");
    expect(index.files).toHaveLength(200_000);
    expect(index.truncated).toBe(true);
  });

  it("uses the list cache for the remote index", async () => {
    mocks.invoke.mockResolvedValue([]);
    await editorIndexFilesFor(SSH_LOCATION, "/home/alwi/p-cache");
    await editorIndexFilesFor(SSH_LOCATION, "/home/alwi/p-cache");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});

describe("editorRenameEntryFor / editorRevealEntry", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ path: "/repo/x" });
  });

  it("renames over SSH with both paths relative to the remote root", async () => {
    await editorRenameEntryFor(SSH_LOCATION, "src/a.rs", "src/b.rs", { remoteRoot: "/home/alwi/project/app" });

    expect(mocks.invoke).toHaveBeenCalledWith("editor_rename_entry_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project/app",
      fromRelativePath: "src/a.rs",
      toRelativePath: "src/b.rs",
    });
  });

  it("renames locally inside the root", async () => {
    await editorRenameEntryFor(LOCAL_LOCATION, "src/a.rs", "src/b.rs");

    expect(mocks.invoke).toHaveBeenCalledWith("editor_rename_entry", {
      root: "/Users/alwi/project",
      fromRelativePath: "src/a.rs",
      toRelativePath: "src/b.rs",
    });
  });

  it("refuses without a root", async () => {
    await expect(editorRenameEntryFor(null, "a", "b")).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("reveals a local entry in Finder", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await editorRevealEntry("/Users/alwi/project", "src/a.rs");
    expect(mocks.invoke).toHaveBeenCalledWith("editor_reveal_entry", {
      root: "/Users/alwi/project",
      relativePath: "src/a.rs",
    });
  });
});
