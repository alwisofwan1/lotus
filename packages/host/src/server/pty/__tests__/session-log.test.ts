import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLog } from "../session-log.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "slog-"));
  dirs.push(d);
  return d;
}

const b = (s: string) => Buffer.from(s, "utf8");

describe("SessionLog", () => {
  it("appends at absolute offsets and reads any range back", () => {
    const log = new SessionLog(dir(), "s1");
    expect(log.append(0, b("hello "))).toEqual(b("hello "));
    expect(log.append(6, b("world"))).toEqual(b("world"));
    expect(log.total()).toBe(11);
    expect(log.read(3, 5)).toEqual({ text: "lo wo", offset: 3 });
    expect(log.read(20, 5)).toEqual({ text: "", offset: 11 });
  });

  it("keeps only the new part of output it already holds", () => {
    const log = new SessionLog(dir(), "s1");
    log.append(0, b("abcd"));
    expect(log.append(2, b("cdef"))).toEqual(b("ef"));
    expect(log.append(0, b("ab"))).toEqual(b(""));
    expect(log.read(0, 100).text).toBe("abcdef");
  });

  it("rotates into one older generation and keeps offsets absolute", () => {
    const log = new SessionLog(dir(), "s1", 4);
    log.append(0, b("aaaaa")); // over the cap: becomes the old generation
    log.append(5, b("bbbbb")); // over again: "aaaaa" is dropped
    log.append(10, b("cc"));
    expect(log.total()).toBe(12);
    expect(log.read(0, 100)).toEqual({ text: "bbbbb", offset: 5 });
    expect(log.read(5, 100)).toEqual({ text: "bbbbb", offset: 5 });
    expect(log.read(10, 100)).toEqual({ text: "cc", offset: 10 });
  });

  it("a later process finds the same history at the same offsets", () => {
    const d = dir();
    const first = new SessionLog(d, "s1", 4);
    first.append(0, b("aaaaa"));
    first.append(5, b("bbbbb"));
    const again = new SessionLog(d, "s1", 4);
    expect(again.total()).toBe(10);
    expect(again.read(0, 100)).toEqual({ text: "bbbbb", offset: 5 });
  });

  it("starts over at a gap rather than serve bytes at the wrong offsets", () => {
    const log = new SessionLog(dir(), "s1");
    log.append(0, b("old"));
    expect(log.append(100, b("new"))).toEqual(b("new"));
    expect(log.total()).toBe(103);
    expect(log.read(0, 100)).toEqual({ text: "new", offset: 100 });
  });

  it("removes every file it wrote", () => {
    const d = dir();
    const log = new SessionLog(d, "s1", 2);
    log.append(0, b("abc"));
    log.append(3, b("d"));
    log.remove();
    expect(["s1.log", "s1.log.1", "s1.base"].some((f) => existsSync(join(d, f)))).toBe(false);
  });
});
