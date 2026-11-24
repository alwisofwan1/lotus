import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { atomicWriteJSON, atomicWriteSync } from "../atomic-write.js";

describe("atomicWriteJSON", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-atomic-write-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes JSON to the target path", async () => {
    const target = join(dir, "data.json");
    await atomicWriteJSON(target, { foo: 1, bar: "baz" });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ foo: 1, bar: "baz" });
  });

  it("does not leave a tmp sibling after a successful write", async () => {
    const target = join(dir, "data.json");
    await atomicWriteJSON(target, { x: 1 });

    const entries = readdirSync(dir);
    expect(entries).toEqual(["data.json"]);
  });

  it("overwrites an existing target", async () => {
    const target = join(dir, "data.json");
    await atomicWriteJSON(target, { v: 1 });
    await atomicWriteJSON(target, { v: 2 });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ v: 2 });
  });

  it("formats the JSON with 2-space indentation", async () => {
    const target = join(dir, "data.json");
    await atomicWriteJSON(target, { foo: 1 });

    expect(readFileSync(target, "utf8")).toBe(`{\n  "foo": 1\n}`);
  });

  it("atomicWriteSync writes JSON synchronously and leaves no tmp behind", () => {
    const target = join(dir, "sync.json");
    atomicWriteSync(target, { v: 42 });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ v: 42 });
    expect(readdirSync(dir)).toEqual(["sync.json"]);
  });
});
