import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StructuredFleetRef } from "../../structured-fleet-ref.js";
import { structuredConversationStreamHandler } from "../structured-conversation-stream.js";
import type { ConversationListener, ConversationPage, ConversationUpdate } from "../../../types/conversation.js";

const PANE = "ss-1";
const BOOT = "boot-a";

function update(n: number): ConversationUpdate {
  return { kind: "text", turnId: "t1", partId: "p1", delta: `d${n}`, seq: n };
}

/** A surface with a ring of `held` cursors (1..held) and a live listener hook. */
function fakeFleet(held: number, ringStart = 1) {
  const listeners = new Set<ConversationListener>();
  let alive = true;
  let restored = true;
  const ref = new StructuredFleetRef();
  ref.bind({
    ready: () => restored,
    list: () => [],
    page: (id) => (id === PANE && alive ? ({} as ConversationPage) : undefined),
    since: (_id, cursor) => {
      const all = Array.from({ length: held - ringStart + 1 }, (_, i) => ringStart + i);
      if (cursor > 0 && cursor < ringStart - 1) return { deltas: [], truncated: true, oldestCursor: ringStart };
      return {
        deltas: all.filter((c) => c > cursor).map((c) => ({ cursor: c, agentType: "claude", update: update(c) })),
        truncated: false,
        oldestCursor: ringStart,
      };
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  });
  return {
    ref,
    listeners,
    emit: (cursor: number, pane = PANE) => listeners.forEach((l) => l(pane, "claude", update(cursor), cursor)),
    end: () => { alive = false; },
    restoring: () => { restored = false; alive = false; },
  };
}

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(ref: StructuredFleetRef, opts: { heartbeatMs?: number } = {}): Promise<string> {
  const handler = structuredConversationStreamHandler(ref, { bootId: BOOT, heartbeatMs: opts.heartbeatMs ?? 60_000 });
  server = createServer((req, res) => void handler(req, res, {}));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/cell-conversation/stream`;
}

/** Reads SSE frames until `until` says stop, then aborts. */
async function frames(url: string, init: RequestInit, until: (f: string[]) => boolean): Promise<string[]> {
  const ctrl = new AbortController();
  const res = await fetch(url, { ...init, signal: ctrl.signal });
  const reader = res.body!.getReader();
  const out: string[] = [];
  let buf = "";
  while (!until(out)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    out.push(...parts);
  }
  ctrl.abort();
  return out;
}

const ids = (f: string[]) => f.map((x) => /^id: (.*)$/m.exec(x)?.[1]).filter(Boolean);

describe("GET /v1/cell-conversation/stream", () => {
  it("400 without pane_id, 404 for a pane that is not headless here", async () => {
    const url = await serve(fakeFleet(0).ref);
    expect((await fetch(url)).status).toBe(400);
    expect((await fetch(`${url}?pane_id=nope`)).status).toBe(404);
  });

  it("says hello with the boot id, replays the ring, then streams live", async () => {
    const fleet = fakeFleet(2);
    const url = await serve(fleet.ref);
    const got = frames(`${url}?pane_id=${PANE}`, {}, (f) => f.length >= 4);
    await new Promise((r) => setTimeout(r, 50));
    fleet.emit(3);
    fleet.emit(9, "other-pane");
    const f = await got;
    expect(f[0]).toContain("event: hello");
    expect(f[0]).toContain(`"bootId":"${BOOT}"`);
    expect(ids(f)).toEqual([`${BOOT}:1`, `${BOOT}:2`, `${BOOT}:3`]);
  });

  it("resumes after Last-Event-ID from the same boot", async () => {
    const url = await serve(fakeFleet(3).ref);
    const f = await frames(`${url}?pane_id=${PANE}`, { headers: { "Last-Event-ID": `${BOOT}:2` } }, (x) => x.length >= 2);
    expect(ids(f)).toEqual([`${BOOT}:3`]);
  });

  it("says truncated when the host restarted since the client's cursor", async () => {
    const url = await serve(fakeFleet(3).ref);
    const f = await frames(`${url}?pane_id=${PANE}&after=2&boot=older-boot`, {}, (x) => x.length >= 2);
    expect(f[1]).toContain("event: truncated");
    expect(f[1]).toContain('"reason":"host-restarted"');
    expect(ids(f)).toEqual([]);
  });

  it("says truncated when the cursor fell off the ring", async () => {
    const url = await serve(fakeFleet(10, 6).ref);
    const f = await frames(`${url}?pane_id=${PANE}&after=2&boot=${BOOT}`, {}, (x) => x.length >= 2);
    expect(f[1]).toContain('"reason":"ring"');
  });

  it("does not lose a delta published while the ring is replayed", async () => {
    const fleet = fakeFleet(1);
    const since = fleet.ref.since.bind(fleet.ref);
    fleet.ref.since = (id, c) => {
      const answer = since(id, c);
      fleet.emit(2); // arrives between subscribe and replay
      return answer;
    };
    const url = await serve(fleet.ref);
    const f = await frames(`${url}?pane_id=${PANE}`, {}, (x) => x.length >= 3);
    expect(ids(f)).toEqual([`${BOOT}:1`, `${BOOT}:2`]);
  });

  it("heartbeats, says ended when the cell is gone, and unsubscribes", async () => {
    const fleet = fakeFleet(0);
    const url = await serve(fleet.ref, { heartbeatMs: 20 });
    const got = frames(`${url}?pane_id=${PANE}`, {}, (x) => x.some((y) => y.includes("event: ended")));
    await new Promise((r) => setTimeout(r, 30));
    fleet.end();
    const f = await got;
    expect(f.some((x) => x.startsWith(": ping"))).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(fleet.listeners.size).toBe(0);
  });

  it("503, not 404, while the host is still restoring its cells: the client must not give the pane up", async () => {
    const fleet = fakeFleet(0);
    fleet.restoring();
    const url = await serve(fleet.ref);
    expect((await fetch(`${url}?pane_id=${PANE}`)).status).toBe(503);
  });

  it("closes the stream without `ended` when the host stops, and refuses new streams with 503", async () => {
    const fleet = fakeFleet(1);
    const url = await serve(fleet.ref);
    const got = frames(`${url}?pane_id=${PANE}`, {}, (x) => x.length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    fleet.ref.close();
    fleet.end();
    const all = await got;
    expect(all.some((f) => f.includes("event: ended"))).toBe(false);
    expect(fleet.listeners.size).toBe(0);
    expect((await fetch(`${url}?pane_id=${PANE}`)).status).toBe(503);
  });
});
