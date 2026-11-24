import type { ServerResponse } from "node:http";

import { AttachmentRefused, type ChatAttachmentStore } from "../../core/chat-attachments.js";
import type { RouteHandler } from "../router.js";
import { readJson } from "./utils.js";

function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function refusal(res: ServerResponse, err: unknown): void {
  if (err instanceof AttachmentRefused) return reply(res, err.status, { ok: false, error: err.message });
  reply(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
}

/** `POST /v1/chat-attachments?thread&name&mime&sha256` — the raw bytes of one Chat Attachment (ADR-0069). */
export function chatAttachmentUploadHandler(store: ChatAttachmentStore): RouteHandler {
  return async (req, res) => {
    const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const mime = q.get("mime") ?? undefined;
    try {
      const saved = await store.save({
        thread: q.get("thread") ?? "",
        name: q.get("name") ?? "file",
        sha256: q.get("sha256") ?? "",
        body: req,
        ...(mime ? { mimeType: mime } : {}),
      });
      reply(res, 200, { ok: true, ...saved });
    } catch (err) {
      // A refused upload stops reading; the connection closes so the sender stops writing too.
      res.setHeader("connection", "close");
      refusal(res, err);
    }
  };
}

/** `POST /v1/chat-attachments/drop {thread}` — a deleted chat's copies go with it. */
export function chatAttachmentDropHandler(store: ChatAttachmentStore): RouteHandler {
  return async (req, res) => {
    const body = await readJson<{ thread?: unknown }>(req).catch(() => ({}) as { thread?: unknown });
    if (typeof body.thread !== "string") return reply(res, 400, { ok: false, error: "thread is required" });
    store.dropThread(body.thread);
    reply(res, 200, { ok: true });
  };
}
