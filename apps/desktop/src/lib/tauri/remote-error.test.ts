import { describe, expect, it } from "vitest";
import {
  formatRemoteError,
  isRemoteError,
  parseRemoteError,
  remoteErrorSeverity,
  type RemoteError,
} from "@/lib/tauri/remote-error";

// ── isRemoteError ──────────────────────────────────────────────────────────────

describe("isRemoteError", () => {
  it("accepts objects with known code fields", () => {
    expect(isRemoteError({ code: "NOT_FOUND" })).toBe(true);
    expect(isRemoteError({ code: "MTIME_CONFLICT", current_mtime: null })).toBe(true);
    expect(isRemoteError({ code: "TOO_LARGE", size: 500, limit: 10485760 })).toBe(true);
    expect(isRemoteError({ code: "AUTH_FAILURE" })).toBe(true);
    expect(isRemoteError({ code: "OTHER", message: "oops" })).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isRemoteError("NOT_FOUND")).toBe(false);
    expect(isRemoteError(42)).toBe(false);
    expect(isRemoteError(null)).toBe(false);
    expect(isRemoteError(undefined)).toBe(false);
  });

  it("rejects objects with unknown or missing code", () => {
    expect(isRemoteError({ code: "UNKNOWN_TAG" })).toBe(false);
    expect(isRemoteError({ message: "oops" })).toBe(false);
    expect(isRemoteError({})).toBe(false);
  });
});

// ── parseRemoteError ───────────────────────────────────────────────────────────

describe("parseRemoteError", () => {
  it("passes through a valid RemoteError object unchanged", () => {
    const err: RemoteError = { code: "NOT_FOUND" };
    expect(parseRemoteError(err)).toEqual(err);
  });

  it("passes through MTIME_CONFLICT with current_mtime intact", () => {
    const err = { code: "MTIME_CONFLICT", current_mtime: 1714838400000 };
    const result = parseRemoteError(err);
    expect(result).toEqual({ code: "MTIME_CONFLICT", current_mtime: 1714838400000 });
  });

  it("passes through TOO_LARGE with size and limit", () => {
    const err = { code: "TOO_LARGE", size: 11534336, limit: 10485760 };
    const result = parseRemoteError(err);
    expect(result).toEqual({ code: "TOO_LARGE", size: 11534336, limit: 10485760 });
  });

  it("wraps a plain string error in OTHER", () => {
    const result = parseRemoteError("Remote path not found.");
    expect(result).toEqual({ code: "OTHER", message: "Remote path not found." });
  });

  it("wraps unknown objects in OTHER with stringified content", () => {
    const result = parseRemoteError({ something: "weird" });
    expect(result.code).toBe("OTHER");
  });

  it("wraps primitives in OTHER", () => {
    expect(parseRemoteError(42).code).toBe("OTHER");
    expect(parseRemoteError(null).code).toBe("OTHER");
    expect(parseRemoteError(undefined).code).toBe("OTHER");
  });
});

// ── formatRemoteError ──────────────────────────────────────────────────────────

describe("formatRemoteError", () => {
  it("returns the right message for each unit code", () => {
    const cases: [RemoteError, string][] = [
      [{ code: "NOT_FOUND" }, "Remote path not found."],
      [{ code: "PARENT_NOT_FOUND" }, "Remote parent directory does not exist."],
      [{ code: "ESCAPE" }, "Remote path escapes the workspace root."],
      [{ code: "NOT_A_FILE" }, "Remote path is not a regular file."],
      [{ code: "ALREADY_EXISTS" }, "Remote path already exists."],
      [{ code: "IS_ROOT" }, "Refusing to delete the workspace root."],
    ];
    for (const [err, expected] of cases) {
      expect(formatRemoteError(err)).toBe(expected);
    }
  });

  it("formats MTIME_CONFLICT with reload guidance", () => {
    const msg = formatRemoteError({ code: "MTIME_CONFLICT", current_mtime: null });
    expect(msg).toContain("modified");
    expect(msg.toLowerCase()).toContain("reload");
  });

  it("formats TOO_LARGE with human-readable size and limit", () => {
    const msg = formatRemoteError({ code: "TOO_LARGE", size: 11_534_336, limit: 10_485_760 });
    expect(msg).toMatch(/11\.0 MB/);
    expect(msg).toMatch(/10\.0 MB/);
  });

  it("formats TOO_LARGE with KB for sub-MB sizes", () => {
    const msg = formatRemoteError({ code: "TOO_LARGE", size: 2048, limit: 1024 });
    expect(msg).toContain("2.0 KB");
    expect(msg).toContain("1.0 KB");
  });

  it("formats AUTH_FAILURE with ssh-add guidance", () => {
    const msg = formatRemoteError({ code: "AUTH_FAILURE" });
    expect(msg).toContain("authentication failed");
    expect(msg).toContain("ssh-add");
  });

  it("formats TIMEOUT with cloudflared guidance", () => {
    const msg = formatRemoteError({ code: "TIMEOUT" });
    expect(msg).toContain("timed out");
    expect(msg).toContain("cloudflared");
  });

  it("uses the message field for OTHER", () => {
    const msg = formatRemoteError({ code: "OTHER", message: "disk full" });
    expect(msg).toBe("disk full");
  });

  it("falls back to generic message for OTHER with empty message", () => {
    const msg = formatRemoteError({ code: "OTHER", message: "" });
    expect(msg).toBeTruthy();
  });
});

// ── remoteErrorSeverity ────────────────────────────────────────────────────────

describe("remoteErrorSeverity", () => {
  it("classifies MTIME_CONFLICT as conflict", () => {
    expect(remoteErrorSeverity({ code: "MTIME_CONFLICT", current_mtime: null })).toBe("conflict");
  });

  it("classifies auth errors as auth", () => {
    expect(remoteErrorSeverity({ code: "AUTH_FAILURE" })).toBe("auth");
    expect(remoteErrorSeverity({ code: "TIMEOUT" })).toBe("auth");
  });

  it("classifies path errors as recoverable", () => {
    for (const code of ["NOT_FOUND", "PARENT_NOT_FOUND", "ESCAPE", "NOT_A_FILE", "ALREADY_EXISTS", "IS_ROOT"] as const) {
      expect(remoteErrorSeverity({ code })).toBe("recoverable");
    }
  });

  it("classifies TOO_LARGE and OTHER as fatal", () => {
    expect(remoteErrorSeverity({ code: "TOO_LARGE", size: 0, limit: 0 })).toBe("fatal");
    expect(remoteErrorSeverity({ code: "OTHER", message: "" })).toBe("fatal");
  });
});
