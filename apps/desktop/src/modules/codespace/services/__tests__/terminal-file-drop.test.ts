import { describe, expect, it } from "vitest";
import {
  SSH_CONFIRM_THRESHOLD_BYTES,
  SSH_HARD_LIMIT_BYTES,
  assembleDroppedPathPrompt,
  classifyDropInspection,
  dragDropHitTestPoints,
  quoteDroppedPath,
  sshUploadPolicy,
} from "../terminal-file-drop";

describe("Terminal File Drop policy", () => {
  it("escapes POSIX paths without wrapping them in quotes and preserves order with a trailing space", () => {
    expect(assembleDroppedPathPrompt(["/tmp/a b.txt", "/tmp/it's.png"], "posix")).toBe("/tmp/a\\ b.txt /tmp/it\\'s.png ");
  });

  it("quotes Windows paths for PowerShell and cmd", () => {
    expect(quoteDroppedPath("C:\\Users\\Alwi\\it's.txt", "powershell")).toBe("'C:\\Users\\Alwi\\it''s.txt'");
    expect(quoteDroppedPath("C:\\Users\\Alwi\\a b.txt", "cmd")).toBe('"C:\\Users\\Alwi\\a b.txt"');
  });

  it("rejects directories and non-files from inspected native paths", () => {
    const result = classifyDropInspection([
      { path: "/tmp/a.txt", name: "a.txt", size: 1, isFile: true, isDirectory: false },
      { path: "/tmp/folder", name: "folder", size: 0, isFile: false, isDirectory: true },
      { path: "/tmp/socket", name: "socket", size: 0, isFile: false, isDirectory: false },
    ]);
    expect(result.accepted.map((entry) => entry.path)).toEqual(["/tmp/a.txt"]);
    expect(result.rejected).toHaveLength(2);
  });

  it("deduplicates repeated native paths before assembling a terminal prompt", () => {
    const result = classifyDropInspection([
      { path: "/tmp/snap.png", name: "snap.png", size: 10, isFile: true, isDirectory: false },
      { path: "/tmp/snap.png", name: "snap.png", size: 10, isFile: true, isDirectory: false },
      { path: "/tmp/other.png", name: "other.png", size: 20, isFile: true, isDirectory: false },
    ]);

    expect(result.accepted.map((entry) => entry.path)).toEqual(["/tmp/snap.png", "/tmp/other.png"]);
    expect(result.totalBytes).toBe(30);
    expect(assembleDroppedPathPrompt(result.accepted.map((entry) => entry.path), "posix")).toBe("/tmp/snap.png /tmp/other.png ");
  });

  it("asks confirmation for large SSH drops and rejects over the hard cap", () => {
    expect(sshUploadPolicy(SSH_CONFIRM_THRESHOLD_BYTES - 1)).toEqual({ kind: "allow" });
    expect(sshUploadPolicy(SSH_CONFIRM_THRESHOLD_BYTES + 1)).toEqual({ kind: "confirm" });
    expect(sshUploadPolicy(SSH_HARD_LIMIT_BYTES + 1)).toEqual({ kind: "reject", reason: "SSH file drops are limited to 250 MB per batch." });
  });

  it("hit-tests native drag positions as reported first, then scaled fallback", () => {
    expect(dragDropHitTestPoints({ x: 1600, y: 300 }, 2)).toEqual([
      { x: 1600, y: 300 },
      { x: 800, y: 150 },
    ]);
  });
});
