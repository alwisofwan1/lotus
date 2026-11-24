import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ChatAttachmentStore } from "../../../core/chat-attachments.js";

import type { ApiClient } from "../../../core/api-client.js";
import { chatActions } from "../chat-actions.js";
import type { StructuredSessions } from "../structured/structured-sessions.js";

function setup(attachments?: ChatAttachmentStore, cwd = "/w") {
  const structured = {
    list: () => [{ paneId: "ss-1", cwd }],
    has: (id: string) => id === "ss-1",
    canRun: () => true,
    headlessRunners: () => ["claude"],
    spawn: vi.fn().mockResolvedValue({ paneId: "ss-2", sessionId: "s" }),
    dispatch: vi.fn(async (id: string): Promise<"sent" | "blocked" | "unknown"> => (id === "ss-1" ? "sent" : "unknown")),
    input: vi.fn((id: string) => id === "ss-1"),
    stop: vi.fn(async (id: string) => id === "ss-1"),
    setPosture: vi.fn(async (id: string) => id === "ss-1"),
    close: vi.fn((id: string) => id === "ss-1"),
    permission: vi.fn((id: string) => (id === "ss-1" ? { paneId: id, awaiting: false } : undefined)),
  };
  const act = chatActions({
    structured: structured as unknown as StructuredSessions,
    api: { listProjects: async () => ({ items: [{ workspaceId: "w", name: "W", path: "/w", lastOpenedAt: 1 }] }) } as unknown as Pick<ApiClient, "listProjects">,
    profiles: () => [],
    hostDefault: () => undefined,
    ...(attachments ? { attachments } : {}),
  });
  return { structured, act };
}

describe("chatActions", () => {
  it("spawns a headless cell through the same path as the phone", async () => {
    const t = setup();
    const r = await t.act("spawn", { provider: "claude", workspaceId: "w", initialPrompt: "hi" });
    expect(r).toEqual({ status: 200, body: { paneId: "ss-2", sessionId: "s" } });
    expect(t.structured.spawn.mock.calls[0]?.[0]).toMatchObject({ cwd: "/w", initialPrompt: "hi" });
  });

  it("refuses a spawn with an unknown permission mode before starting anything", async () => {
    const t = setup();
    const r = await t.act("spawn", { provider: "claude", workspaceId: "w", permissionMode: "explode" });
    expect(r.status).toBe(400);
    expect(t.structured.spawn).not.toHaveBeenCalled();
  });

  it("sends text, and says 409 when the cell holds an approval", async () => {
    const t = setup();
    expect(await t.act("send", { pane_id: "ss-1", text: "next" })).toEqual({ status: 200, body: { ok: true } });
    t.structured.dispatch.mockResolvedValueOnce("blocked");
    expect((await t.act("send", { pane_id: "ss-1", text: "next" })).status).toBe(409);
    expect((await t.act("send", { pane_id: "ss-1", text: " " })).status).toBe(400);
  });

  it("sends attachments from the upload store and the cell's folder, and marks them sent", async () => {
    const store = new ChatAttachmentStore(join(mkdtempSync(join(tmpdir(), "att-")), "chat-attachments"));
    const sha = createHash("sha256").update("x").digest("hex");
    const up = await store.save({ thread: "t1", name: "a.png", mimeType: "image/png", sha256: sha, body: [Buffer.from("x")] });
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    writeFileSync(join(cwd, "env.ts"), "y");
    const t = setup(store, cwd);
    const r = await t.act("send", { pane_id: "ss-1", text: "", attachments: [
      { kind: "image", path: up.path, name: "a.png", mimeType: "image/png" },
      { kind: "file", path: join(cwd, "env.ts"), name: "env.ts" },
    ] });
    expect(r.status).toBe(200);
    const sent = t.structured.dispatch.mock.calls[0] as unknown[];
    expect((sent[2] as Array<{ name: string }>).map((a) => a.name)).toEqual(["a.png", "env.ts"]);
    expect(store.sweep(-1)).toBe(0);
  });

  it("refuses an attachment outside the allowed folders before sending", async () => {
    const store = new ChatAttachmentStore(join(mkdtempSync(join(tmpdir(), "att-")), "chat-attachments"));
    const t = setup(store, mkdtempSync(join(tmpdir(), "cwd-")));
    const r = await t.act("send", { pane_id: "ss-1", text: "hi", attachments: [{ kind: "file", path: "/etc/hosts", name: "hosts" }] });
    expect(r.status).toBe(403);
    expect(t.structured.dispatch).not.toHaveBeenCalled();
  });

  it("says this host takes no attachments when it has no store", async () => {
    const t = setup();
    expect((await t.act("send", { pane_id: "ss-1", text: "hi", attachments: [] })).status).toBe(400);
  });

  it("answers 404 for a pane that is not a headless cell here", async () => {
    const t = setup();
    for (const action of ["send", "answer", "stop", "posture", "close", "permission"]) {
      const r = await t.act(action, { pane_id: "nope", text: "x", data: "1", mode: "default" });
      expect(r.status, action).toBe(404);
    }
  });

  it("answers an approval, stops, moves posture, reads the permission, closes", async () => {
    const t = setup();
    expect((await t.act("answer", { pane_id: "ss-1", data: "1" })).status).toBe(200);
    expect(t.structured.input).toHaveBeenCalledWith("ss-1", "1");
    expect((await t.act("stop", { pane_id: "ss-1" })).status).toBe(200);
    expect((await t.act("posture", { pane_id: "ss-1", mode: "acceptEdits" })).status).toBe(200);
    expect((await t.act("posture", { pane_id: "ss-1", mode: "explode" })).status).toBe(400);
    expect(await t.act("permission", { pane_id: "ss-1" })).toEqual({ status: 200, body: { paneId: "ss-1", awaiting: false } });
    expect((await t.act("close", { pane_id: "ss-1" })).status).toBe(200);
  });

  it("names an unknown action", async () => {
    expect((await setup().act("explode", {})).status).toBe(404);
  });
});
