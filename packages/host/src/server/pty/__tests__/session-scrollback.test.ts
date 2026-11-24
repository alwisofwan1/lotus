import { describe, it, expect, vi } from "vitest";
import { PtySession, type PtyBackend, type PtyScrollback, type PtySpawnFn } from "../session.js";

/// A backend that carries durable history, the way the sessiond one does.
function backendWithHistory(history: string) {
  let contents = history;
  let onData: ((chunk: string) => void) | undefined;

  const scrollback: PtyScrollback = {
    bytesSeen: () => Buffer.byteLength(contents, "utf8"),
    read: (fromByte, maxBytes) => {
      const buf = Buffer.from(contents, "utf8");
      const start = Math.min(Math.max(fromByte, 0), buf.length);
      return { text: buf.subarray(start, start + maxBytes).toString("utf8"), offset: start };
    },
  };

  const backend: PtyBackend = {
    onData: (l) => { onData = l; },
    onExit: () => undefined,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    scrollback,
  };

  return {
    spawnFn: (() => backend) as PtySpawnFn,
    emit: (chunk: string) => { contents += chunk; onData?.(chunk); },
  };
}

const make = (spawnFn: PtySpawnFn) => new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], spawnFn);

describe("PtySession with a durable scrollback source", () => {
  it("reports the source's byte count, not what this process happened to see", () => {
    // The point of the whole exercise: a host that just reattached has seen zero bytes,
    // and must still tell the truth about a session that has been running for hours.
    const h = backendWithHistory("dua jam output sebelumnya");
    const session = make(h.spawnFn);
    expect(session.bytesSeen).toBe(25);
  });

  it("serves history from before this process existed", () => {
    const h = backendWithHistory("sebelum restart\n");
    const session = make(h.spawnFn);
    expect(session.readScrollback(0).text).toBe("sebelum restart\n");
  });

  it("never reports a gap, because a file cannot lose its middle", () => {
    const h = backendWithHistory("x".repeat(5000));
    const session = make(h.spawnFn);
    // The ring's contract makes `offset` run ahead of the request once data has scrolled
    // away. A file-backed source has nothing to scroll away, so the honest answer is
    // always the offset that was asked for.
    expect(session.readScrollback(4000).offset).toBe(4000);
  });

  it("counts bytes, not UTF-16 units, when the offset lands mid-history", () => {
    const h = backendWithHistory("├── src\n");
    const session = make(h.spawnFn);
    expect(session.bytesSeen).toBe(Buffer.byteLength("├── src\n", "utf8"));
    expect(session.readScrollback(0).text).toBe("├── src\n");
  });

  it("grows as the session produces output", () => {
    const h = backendWithHistory("awal ");
    const session = make(h.spawnFn);
    h.emit("lanjut");
    expect(session.bytesSeen).toBe(11);
    expect(session.readScrollback(0).text).toBe("awal lanjut");
  });

  it("still delivers live chunks to subscribers", () => {
    const h = backendWithHistory("");
    const session = make(h.spawnFn);
    const seen: string[] = [];
    session.subscribeData((c) => seen.push(c));
    h.emit("halo");
    expect(seen).toEqual(["halo"]);
  });

  it("takes the tail from the source so a fresh host has a preview to show", () => {
    const h = backendWithHistory("0123456789");
    const session = make(h.spawnFn);
    expect(session.getBufferTail(4)).toBe("6789");
  });

  it("returns the whole history when the tail asked for exceeds it", () => {
    const h = backendWithHistory("pendek");
    const session = make(h.spawnFn);
    expect(session.getBufferTail(1000)).toBe("pendek");
  });
});
