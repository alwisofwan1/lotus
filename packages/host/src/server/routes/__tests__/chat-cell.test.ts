import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StructuredFleetRef } from "../../structured-fleet-ref.js";
import { chatCellHandler, RecentAnswers } from "../chat-cell.js";
import type { ChatActionResult } from "../../../types/conversation.js";

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(ref: StructuredFleetRef, recent = new RecentAnswers()): Promise<string> {
  const handler = chatCellHandler(ref, recent);
  server = createServer((req, res) => {
    const action = (req.url ?? "").split("/").pop() ?? "";
    void handler(req, res, { action });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/chat-cell`;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function bound(answer: ChatActionResult = { status: 200, body: { ok: true } }) {
  const act = vi.fn(async () => answer);
  const ref = new StructuredFleetRef();
  ref.bind({ list: () => [], page: () => undefined, act });
  return { ref, act };
}

describe("POST /v1/chat-cell/:action", () => {
  it("hands the action and body to the adapter and answers what it decided", async () => {
    const { ref, act } = bound({ status: 409, body: { ok: false, error: "waiting for an approval" } });
    const url = await serve(ref);
    const res = await post(`${url}/send`, { pane_id: "ss-1", text: "hi" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "waiting for an approval" });
    expect(act).toHaveBeenCalledWith("send", { pane_id: "ss-1", text: "hi" });
  });

  it("answers 503 when no adapter runs headless cells", async () => {
    const url = await serve(new StructuredFleetRef());
    expect((await post(`${url}/send`, {})).status).toBe(503);
  });

  it("runs a repeated requestId once and replays the first answer", async () => {
    const { ref, act } = bound({ status: 200, body: { paneId: "ss-9" } });
    const url = await serve(ref);
    const first = await post(`${url}/spawn`, { provider: "claude", requestId: "r-1" });
    const again = await post(`${url}/spawn`, { provider: "claude", requestId: "r-1" });
    expect(await again.json()).toEqual(await first.json());
    expect(act).toHaveBeenCalledTimes(1);
    await post(`${url}/spawn`, { provider: "claude", requestId: "r-2" });
    expect(act).toHaveBeenCalledTimes(2);
  });

  it("runs a retry concurrent with the first once too", async () => {
    let release!: () => void;
    const act = vi.fn(() => new Promise<ChatActionResult>((r) => { release = () => r({ status: 200, body: { ok: true } }); }));
    const ref = new StructuredFleetRef();
    ref.bind({ list: () => [], page: () => undefined, act });
    const url = await serve(ref);
    const a = post(`${url}/send`, { requestId: "r-1" });
    await new Promise((r) => setTimeout(r, 30));
    const b = post(`${url}/send`, { requestId: "r-1" });
    await new Promise((r) => setTimeout(r, 30));
    release();
    expect([(await a).status, (await b).status]).toEqual([200, 200]);
    expect(act).toHaveBeenCalledTimes(1);
  });

  it("answers 400 for a body that is not a JSON object", async () => {
    const url = await serve(bound().ref);
    expect((await post(`${url}/send`, [1, 2])).status).toBe(400);
  });
});

describe("RecentAnswers", () => {
  it("forgets an answer after its time-to-live and past its capacity", () => {
    let now = 0;
    const recent = new RecentAnswers({ ttlMs: 100, max: 2, now: () => now });
    const p = Promise.resolve({ status: 200, body: {} });
    recent.remember("a", p);
    expect(recent.get("a")).toBe(p);
    now = 101;
    expect(recent.get("a")).toBeUndefined();
    recent.remember("x", p);
    recent.remember("y", p);
    recent.remember("z", p);
    expect(recent.get("x")).toBeUndefined();
    expect(recent.get("z")).toBe(p);
  });
});
