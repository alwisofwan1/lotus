import { describe, it, expect, vi } from "vitest";
import { createFileWatchRegistry, type FileView } from "../file-node/file-watch-registry";
import type { EditorFsChange } from "@/lib/tauri/editor-watch";

const text = (content: string, extra: Record<string, unknown> = {}) => ({
  content, mtime: 1, sizeBytes: content.length, binary: false, ...extra,
});

function harness(files: Record<string, unknown>) {
  const disk = new Map<string, unknown>(Object.entries(files));
  const read = vi.fn(async (_root: string, _location: unknown, path: string) => {
    const hit = disk.get(path);
    if (hit instanceof Error) throw hit;
    if (hit === undefined) throw new Error("No such file or directory (os error 2)");
    return hit as ReturnType<typeof text>;
  });
  const emitters = new Map<string, (change: EditorFsChange) => void>();
  const stops: string[] = [];
  const watch = vi.fn((root: string, onChange: (change: EditorFsChange) => void) => {
    emitters.set(root, onChange);
    return () => { stops.push(root); emitters.delete(root); };
  });
  let focus: (() => void) | null = null;
  const onWindowFocus = vi.fn((cb: () => void) => { focus = cb; return () => { focus = null; }; });
  const registry = createFileWatchRegistry({ read, watch, onWindowFocus });
  const change = (root: string, c: Partial<EditorFsChange>) => emitters.get(root)?.({ watchId: "w", paths: [], git: false, overflow: false, ...c });
  return { registry, disk, read, watch, stops, change, fireFocus: () => focus?.(), onWindowFocus };
}

const local = { root: "/repo", location: null };
const lastOf = (views: FileView[]) => views[views.length - 1];

describe("file watch registry", () => {
  it("shares ONE watch per root across every file node, and releases it with the last one", async () => {
    const h = harness({ "/repo/a.ts": text("a"), "/repo/b.ts": text("b") });
    const va: FileView[] = [];
    const vb: FileView[] = [];
    const offA = h.registry.subscribe({ ...local, path: "/repo/a.ts" }, (v) => va.push(v));
    const offB = h.registry.subscribe({ ...local, path: "/repo/b.ts" }, (v) => vb.push(v));
    expect(h.watch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(lastOf(va)).toMatchObject({ status: "ready", content: "a" }));
    await vi.waitFor(() => expect(lastOf(vb)).toMatchObject({ status: "ready", content: "b" }));
    offA();
    expect(h.stops).toEqual([]);
    offB();
    expect(h.stops).toEqual(["/repo"]);
  });

  it("starts as loading, then ready", async () => {
    const h = harness({ "/repo/a.ts": text("a") });
    const views: FileView[] = [];
    h.registry.subscribe({ ...local, path: "/repo/a.ts" }, (v) => views.push(v));
    expect(views[0]).toEqual({ status: "loading" });
    await vi.waitFor(() => expect(lastOf(views).status).toBe("ready"));
  });

  it("re-reads only the file a change batch names", async () => {
    const h = harness({ "/repo/a.ts": text("a1"), "/repo/b.ts": text("b1") });
    const va: FileView[] = [];
    const vb: FileView[] = [];
    h.registry.subscribe({ ...local, path: "/repo/a.ts" }, (v) => va.push(v));
    h.registry.subscribe({ ...local, path: "/repo/b.ts" }, (v) => vb.push(v));
    await vi.waitFor(() => expect(lastOf(vb)?.status).toBe("ready"));
    await vi.waitFor(() => expect(lastOf(va)?.status).toBe("ready"));
    h.read.mockClear();
    h.disk.set("/repo/a.ts", text("a2"));
    h.change("/repo", { paths: ["/repo/a.ts"] });
    await vi.waitFor(() => expect(lastOf(va)).toMatchObject({ content: "a2" }));
    expect(h.read.mock.calls.map((c) => c[2])).toEqual(["/repo/a.ts"]);
  });

  it("re-reads everything on overflow and on a git move", async () => {
    const h = harness({ "/repo/a.ts": text("a1"), "/repo/b.ts": text("b1") });
    h.registry.subscribe({ ...local, path: "/repo/a.ts" }, () => {});
    h.registry.subscribe({ ...local, path: "/repo/b.ts" }, () => {});
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    h.change("/repo", { overflow: true });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(4));
    h.change("/repo", { git: true });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(6));
  });

  it("gives two nodes on the same path one read and one state", async () => {
    const h = harness({ "/repo/a.ts": text("a") });
    const v1: FileView[] = [];
    const v2: FileView[] = [];
    h.registry.subscribe({ ...local, path: "/repo/a.ts" }, (v) => v1.push(v));
    h.registry.subscribe({ ...local, path: "/repo/a.ts" }, (v) => v2.push(v));
    await vi.waitFor(() => expect(lastOf(v2)?.status).toBe("ready"));
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(lastOf(v1)).toEqual(lastOf(v2));
  });

  it("classifies binary, too-large, missing and error", async () => {
    const h = harness({
      "/repo/img.png": text("", { binary: true, sizeBytes: 10 }),
      "/repo/big.log": text("", { binary: true, tooLarge: true, sizeBytes: 20_000_000 }),
      "/repo/boom.ts": new Error("Permission denied (os error 13)"),
    });
    const seen: Record<string, FileView> = {};
    for (const name of ["img.png", "big.log", "boom.ts", "gone.ts"]) {
      h.registry.subscribe({ ...local, path: `/repo/${name}` }, (v) => { seen[name] = v; });
    }
    await vi.waitFor(() => expect(Object.values(seen).every((v) => v.status !== "loading")).toBe(true));
    expect(seen["img.png"]).toMatchObject({ status: "binary", sizeBytes: 10 });
    expect(seen["big.log"]).toMatchObject({ status: "too-large", sizeBytes: 20_000_000 });
    expect(seen["gone.ts"]).toEqual({ status: "missing" });
    expect(seen["boom.ts"]).toMatchObject({ status: "error", message: expect.stringContaining("Permission denied") });
  });

  it("turns a deleted file into missing, and back to ready when it returns", async () => {
    const h = harness({ "/repo/a.ts": text("a") });
    const views: FileView[] = [];
    h.registry.subscribe({ ...local, path: "/repo/a.ts" }, (v) => views.push(v));
    await vi.waitFor(() => expect(lastOf(views)?.status).toBe("ready"));
    h.disk.delete("/repo/a.ts");
    h.change("/repo", { paths: ["/repo/a.ts"] });
    await vi.waitFor(() => expect(lastOf(views)).toEqual({ status: "missing" }));
    h.disk.set("/repo/a.ts", text("back"));
    h.change("/repo", { paths: ["/repo/a.ts"] });
    await vi.waitFor(() => expect(lastOf(views)).toMatchObject({ status: "ready", content: "back" }));
  });

  it("does not deliver to a node that unsubscribed while its read was in flight", async () => {
    const h = harness({ "/repo/a.ts": text("a") });
    const listener = vi.fn();
    const off = h.registry.subscribe({ ...local, path: "/repo/a.ts" }, listener);
    listener.mockClear();
    off();
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });

  it("on a remote project never watches, and re-reads on window focus instead", async () => {
    const ssh = { root: "/srv/app", location: { kind: "ssh" as const, host: "vps", remoteCwd: "/srv/app" } };
    const h = harness({ "/srv/app/a.ts": text("v1") });
    const views: FileView[] = [];
    const off = h.registry.subscribe({ ...ssh, path: "/srv/app/a.ts" }, (v) => views.push(v));
    await vi.waitFor(() => expect(lastOf(views)).toMatchObject({ content: "v1" }));
    expect(h.watch).not.toHaveBeenCalled();
    h.disk.set("/srv/app/a.ts", text("v2"));
    h.fireFocus();
    await vi.waitFor(() => expect(lastOf(views)).toMatchObject({ content: "v2" }));
    off();
    expect(h.onWindowFocus).toHaveBeenCalledTimes(1);
  });

  it("bumps rev on every fresh ready so a consumer can refetch its git baseline", async () => {
    const h = harness({ "/repo/a.ts": text("a") });
    const views: FileView[] = [];
    h.registry.subscribe({ ...local, path: "/repo/a.ts" }, (v) => views.push(v));
    await vi.waitFor(() => expect(lastOf(views)?.status).toBe("ready"));
    const first = lastOf(views) as Extract<FileView, { status: "ready" }>;
    h.change("/repo", { git: true });
    await vi.waitFor(() => expect((lastOf(views) as typeof first).rev).toBeGreaterThan(first.rev));
  });
});
