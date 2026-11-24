import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CellBook, type SavedCell } from "../cell-book.js";

const cell = (paneId: string): SavedCell => ({
  member: { paneId, workspaceId: "ws", agentType: "claude", runnerLabel: "Claude Code", title: "Nia", status: "live", isAlive: true },
  spawn: { cwd: "/srv/app", permissionMode: "manual" },
  thread: "sid-1",
  turns: [],
});

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "cell-book-")), "structured-cells.json");

describe("CellBook", () => {
  it("starts empty when the file does not exist", () => {
    expect(new CellBook(tmpFile()).all()).toEqual([]);
  });

  it("survives a reload, and a removed cell stays removed", () => {
    const path = tmpFile();
    const book = new CellBook(path);
    book.put(cell("ss-a"));
    book.put(cell("ss-b"));
    book.remove("ss-a");
    expect(new CellBook(path).all().map((c) => c.member.paneId)).toEqual(["ss-b"]);
  });

  it("writes the file readable by its owner only", () => {
    const path = tmpFile();
    new CellBook(path).put(cell("ss-a"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("moves a corrupt file aside instead of overwriting it", () => {
    const path = tmpFile();
    writeFileSync(path, "{not json");
    expect(new CellBook(path).all()).toEqual([]);
    expect(readFileSync(`${path}.corrupt`, "utf8")).toBe("{not json");
    expect(existsSync(path)).toBe(false);
  });

  it("drops an entry that is not a saved cell", () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify([cell("ss-a"), { member: {} }]));
    expect(new CellBook(path).all().map((c) => c.member.paneId)).toEqual(["ss-a"]);
  });
});
