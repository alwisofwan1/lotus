import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { AttachmentRefused, ChatAttachmentStore, checkAttachments, MAX_FILE_BYTES } from "../chat-attachments.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
async function* chunks(...parts: string[]): AsyncIterable<Buffer> {
  for (const p of parts) yield Buffer.from(p);
}

let root: string;
let store: ChatAttachmentStore;
beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "att-")), "chat-attachments");
  store = new ChatAttachmentStore(root);
});

describe("ChatAttachmentStore.save", () => {
  it("stores the bytes under the thread, named by their sha256", async () => {
    const saved = await store.save({ thread: "t1", name: "run.log", sha256: sha("hello world"), body: chunks("hello ", "world") });
    expect(saved).toEqual({ path: join(root, "t1", `${sha("hello world")}.log`), sha256: sha("hello world"), sizeBytes: 11 });
    expect(readFileSync(saved.path, "utf8")).toBe("hello world");
  });

  it("keeps one copy when the same file comes twice", async () => {
    const a = await store.save({ thread: "t1", name: "a.png", mimeType: "image/png", sha256: sha("x"), body: chunks("x") });
    const b = await store.save({ thread: "t1", name: "b.png", mimeType: "image/png", sha256: sha("x"), body: chunks("x") });
    expect(b.path).toBe(a.path);
  });

  it("refuses bytes that do not match the sha256 the sender named, and keeps nothing", async () => {
    await expect(store.save({ thread: "t1", name: "a.txt", sha256: sha("other"), body: chunks("x") })).rejects.toMatchObject({ status: 422 });
    expect(existsSync(join(root, "t1", `${sha("x")}.txt`))).toBe(false);
  });

  it("refuses a file over the limit while it streams", async () => {
    const big = "a".repeat(MAX_FILE_BYTES + 1);
    await expect(store.save({ thread: "t1", name: "big.txt", sha256: sha(big), body: chunks(big) })).rejects.toMatchObject({ status: 413 });
  });

  it("holds images to 5 MB", async () => {
    const big = "a".repeat(5 * 1024 * 1024 + 1);
    await expect(store.save({ thread: "t1", name: "a.png", mimeType: "image/png", sha256: sha(big), body: chunks(big) })).rejects.toBeInstanceOf(AttachmentRefused);
  });

  it("refuses a thread id that could leave the folder", async () => {
    await expect(store.save({ thread: "../x", name: "a", sha256: sha("x"), body: chunks("x") })).rejects.toMatchObject({ status: 400 });
  });
});

describe("ChatAttachmentStore upkeep", () => {
  it("sweeps only old files that were never sent", async () => {
    const sent = await store.save({ thread: "t1", name: "a.txt", sha256: sha("a"), body: chunks("a") });
    const unsent = await store.save({ thread: "t1", name: "b.txt", sha256: sha("b"), body: chunks("b") });
    const fresh = await store.save({ thread: "t1", name: "c.txt", sha256: sha("c"), body: chunks("c") });
    store.markSent([sent.path]);
    const old = new Date(Date.now() - 25 * 3600_000);
    utimesSync(sent.path, old, old);
    utimesSync(unsent.path, old, old);

    expect(store.sweep()).toBe(1);
    expect([existsSync(sent.path), existsSync(unsent.path), existsSync(fresh.path)]).toEqual([true, false, true]);
  });

  it("counts a file uploaded again as new, so the sweep spares a draft still holding it", async () => {
    const first = await store.save({ thread: "t1", name: "a.txt", sha256: sha("a"), body: chunks("a") });
    const old = new Date(Date.now() - 25 * 3600_000);
    utimesSync(first.path, old, old);
    await store.save({ thread: "t1", name: "a.txt", sha256: sha("a"), body: chunks("a") });
    expect(store.sweep()).toBe(0);
  });

  it("drops a whole thread", async () => {
    const saved = await store.save({ thread: "t1", name: "a.txt", sha256: sha("a"), body: chunks("a") });
    store.dropThread("t1");
    expect(existsSync(saved.path)).toBe(false);
  });
});

describe("checkAttachments", () => {
  it("takes an uploaded file and a file inside the cell's folder", async () => {
    const saved = await store.save({ thread: "t1", name: "a.png", mimeType: "image/png", sha256: sha("x"), body: chunks("x") });
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    writeFileSync(join(cwd, "env.ts"), "x");
    const out = checkAttachments([
      { kind: "image", path: saved.path, name: "a.png", mimeType: "image/png" },
      { kind: "file", path: join(cwd, "env.ts"), name: "env.ts" },
    ], [root, cwd]);
    expect(out.map((a: { name: string }) => a.name)).toEqual(["a.png", "env.ts"]);
    expect(out[1]?.sizeBytes).toBe(1);
  });

  it("refuses a path outside the allowed folders, a missing file, and a bad image type", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    mkdirSync(join(cwd, "dir"));
    writeFileSync(join(cwd, "a.bmp"), "x");
    expect(() => checkAttachments([{ kind: "file", path: "/etc/passwd", name: "p" }], [cwd])).toThrow(AttachmentRefused);
    expect(() => checkAttachments([{ kind: "file", path: join(cwd, "gone"), name: "g" }], [cwd])).toThrow(/no longer there/);
    expect(() => checkAttachments([{ kind: "file", path: join(cwd, "dir"), name: "d" }], [cwd])).toThrow(/folder/);
    expect(() => checkAttachments([{ kind: "image", path: join(cwd, "a.bmp"), name: "a.bmp", mimeType: "image/bmp" }], [cwd])).toThrow(/PNG/);
    expect(() => checkAttachments([{ kind: "file", path: join(cwd, "..", "x"), name: "x" }], [cwd])).toThrow(AttachmentRefused);
    expect(() => checkAttachments("nope", [cwd])).toThrow(/list/);
  });
});
