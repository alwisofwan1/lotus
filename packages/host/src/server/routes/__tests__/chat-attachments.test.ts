import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ChatAttachmentStore } from "../../../core/chat-attachments.js";
import { chatAttachmentDropHandler, chatAttachmentUploadHandler } from "../chat-attachments.js";

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(): Promise<{ url: string; store: ChatAttachmentStore }> {
  const store = new ChatAttachmentStore(join(mkdtempSync(join(tmpdir(), "att-")), "chat-attachments"));
  const upload = chatAttachmentUploadHandler(store);
  const drop = chatAttachmentDropHandler(store);
  server = createServer((req, res) => void ((req.url ?? "").startsWith("/v1/chat-attachments/drop") ? drop : upload)(req, res, {}));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/chat-attachments`, store };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("POST /v1/chat-attachments", () => {
  it("stores the raw body and answers where it lives on this machine", async () => {
    const { url } = await serve();
    const q = new URLSearchParams({ thread: "t1", name: "shot.png", mime: "image/png", sha256: sha("png-bytes") });
    const res = await fetch(`${url}?${q}`, { method: "POST", body: "png-bytes" });
    const body = (await res.json()) as { ok: boolean; path: string; sha256: string; sizeBytes: number };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, sha256: sha("png-bytes"), sizeBytes: 9 });
    expect(readFileSync(body.path, "utf8")).toBe("png-bytes");
  });

  it("answers a refusal with its status and reason", async () => {
    const { url } = await serve();
    const q = new URLSearchParams({ thread: "t1", name: "a.txt", sha256: sha("other") });
    const res = await fetch(`${url}?${q}`, { method: "POST", body: "x" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "a.txt arrived damaged; send it again" });
  });
});

describe("POST /v1/chat-attachments/drop", () => {
  it("removes a chat's copies", async () => {
    const { url } = await serve();
    const q = new URLSearchParams({ thread: "t1", name: "a.txt", sha256: sha("x") });
    const { path } = (await (await fetch(`${url}?${q}`, { method: "POST", body: "x" })).json()) as { path: string };
    const res = await fetch(`${url}/drop`, { method: "POST", body: JSON.stringify({ thread: "t1" }) });
    expect(res.status).toBe(200);
    expect(existsSync(path)).toBe(false);
  });
});
