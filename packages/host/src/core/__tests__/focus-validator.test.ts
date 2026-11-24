import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ApiError } from "../api-client.js";
import { withFocus } from "../focus-validator.js";
import { SessionStore } from "../session-store.js";

describe("withFocus", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-focus-"));
    store = new SessionStore(join(dir, "state.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'no_focus' when no focus is set", async () => {
    const result = await withFocus("42", store, "workspace", async () => "should not run");

    expect(result).toEqual({ kind: "no_focus" });
  });

  it("returns 'no_focus' when paneId is required but not stored", async () => {
    store.setFocus("42", "ws-a"); // workspace only
    const result = await withFocus("42", store, "pane", async () => "should not run");

    expect(result).toEqual({ kind: "no_focus" });
  });

  it("forwards focus info and returns ok with the operation result", async () => {
    store.setFocus("42", "ws-a", "pane-1");
    const result = await withFocus("42", store, "pane", async (focus) => {
      expect(focus).toEqual(expect.objectContaining({ workspaceId: "ws-a", paneId: "pane-1" }));
      return 7;
    });

    expect(result).toEqual({ kind: "ok", result: 7 });
  });

  it("clears focus and returns 'stale' on HTTP 410 Gone", async () => {
    store.setFocus("42", "ws-a", "pane-1");
    const result = await withFocus("42", store, "pane", async () => {
      throw new ApiError(410, "Gone");
    });

    expect(result.kind).toBe("stale");
    expect(store.getFocus("42")).toBeNull();
  });

  it("clears focus and returns 'stale' on HTTP 404 Not Found", async () => {
    store.setFocus("42", "ws-a", "pane-1");
    const result = await withFocus("42", store, "pane", async () => {
      throw new ApiError(404, "Not Found");
    });

    expect(result.kind).toBe("stale");
    expect(store.getFocus("42")).toBeNull();
  });

  it("preserves focus and returns 'offline' on a connection refusal", async () => {
    store.setFocus("42", "ws-a", "pane-1");
    const result = await withFocus("42", store, "pane", async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });

    expect(result.kind).toBe("offline");
    expect(store.getFocus("42")).toEqual(expect.objectContaining({ workspaceId: "ws-a", paneId: "pane-1" }));
  });

  it("rethrows unrecognised errors so callers see the original failure", async () => {
    store.setFocus("42", "ws-a");
    await expect(
      withFocus("42", store, "workspace", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
