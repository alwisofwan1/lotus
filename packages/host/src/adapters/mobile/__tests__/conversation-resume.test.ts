import { describe, expect, it } from "vitest";

import type { ServerEvent } from "../events.js";
import { StreamHub, type StreamSocket } from "../stream-hub.js";
import { DeviceStore } from "../device-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

const HOST = { hostId: "mac", hostLabel: "MacBook", mode: "client" } as const;

let dir: string;
let devices: DeviceStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lotus-resume-"));
  devices = new DeviceStore(join(dir, "devices.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A connection that records what it was sent, the way a phone's socket would receive it. */
function connect(hub: StreamHub): { sent: ServerEvent[]; conn: ReturnType<StreamHub["attach"]> } {
  const sent: ServerEvent[] = [];
  const socket: StreamSocket = {
    send: (data) => sent.push(JSON.parse(data) as ServerEvent),
    close: () => undefined,
  };
  const conn = hub.attach(socket, devices.issue("iPhone"));
  sent.length = 0; // drop the hello
  return { sent, conn };
}

function turnUpdate(id: string) {
  return { kind: "turn" as const, turn: { turnId: id, startedAt: 1 } };
}

describe("resuming the conversation lane", () => {
  it("stamps every delta with a cursor the client can send back", () => {
    const hub = new StreamHub({ host: HOST });
    const { sent } = connect(hub);

    hub.publishConversation("p-1", "claude", turnUpdate("t-0"));
    hub.publishConversation("p-1", "claude", turnUpdate("t-1"));

    expect(sent.map((e) => (e.type === "conversation" ? e.cursor : null))).toEqual([1, 2]);
  });

  it("replays what one connection missed, and only to that one", () => {
    // The failure this closes, reported from a real phone: the socket drops, the lane carries
    // on without it, and the only repair is a manual refresh.
    const hub = new StreamHub({ host: HOST });
    const away = connect(hub);
    hub.publishConversation("p-1", "claude", turnUpdate("t-0"));
    hub.publishConversation("p-1", "claude", turnUpdate("t-1"));

    const other = connect(hub);
    away.sent.length = 0;
    hub.handleMessage(away.conn, JSON.stringify({
      type: "conversation.resume",
      cursors: [{ paneId: "p-1", cursor: 1 }],
    }));

    expect(away.sent.map((e) => (e.type === "conversation" ? e.cursor : null))).toEqual([2]);
    // A backfill broadcast would replay one phone's history onto another's screen.
    expect(other.sent).toEqual([]);
  });

  it("gives a client with no cursor everything held", () => {
    const hub = new StreamHub({ host: HOST });
    hub.publishConversation("p-1", "claude", turnUpdate("t-0"));
    const { sent, conn } = connect(hub);

    hub.handleMessage(conn, JSON.stringify({
      type: "conversation.resume",
      cursors: [{ paneId: "p-1", cursor: 0 }],
    }));

    expect(sent).toHaveLength(1);
  });

  it("repairs every followed cell in one round trip", () => {
    // The phone follows a window of neighbouring cells, so a reconnect must fix them together.
    const hub = new StreamHub({ host: HOST });
    hub.publishConversation("p-1", "claude", turnUpdate("a"));
    hub.publishConversation("p-2", "codex", turnUpdate("b"));
    const { sent, conn } = connect(hub);

    hub.handleMessage(conn, JSON.stringify({
      type: "conversation.resume",
      cursors: [{ paneId: "p-1", cursor: 0 }, { paneId: "p-2", cursor: 0 }],
    }));

    expect(sent.map((e) => (e.type === "conversation" ? e.paneId : null))).toEqual(["p-1", "p-2"]);
  });

  it("names the hole instead of hiding it", () => {
    // Away long enough that the cursor fell off the front of the ring. Handing back the
    // oldest held deltas would look like success and lose the middle of the transcript, so the
    // client is told to refetch instead — the same contract as `cell.truncated`.
    const hub = new StreamHub({ host: HOST });
    for (let i = 0; i < 520; i++) hub.publishConversation("p-1", "claude", turnUpdate(`t-${i}`));
    const { sent, conn } = connect(hub);

    hub.handleMessage(conn, JSON.stringify({
      type: "conversation.resume",
      cursors: [{ paneId: "p-1", cursor: 1 }],
    }));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "conversation.truncated", requestedFromCursor: 1 });
    const only = sent[0];
    if (only?.type !== "conversation.truncated") throw new Error("unreachable");
    expect(only.oldestCursor).toBeGreaterThan(1);
  });

  it("refuses a resume whose shape it cannot trust", () => {
    const hub = new StreamHub({ host: HOST });
    const { sent, conn } = connect(hub);
    for (const body of [
      { type: "conversation.resume" },
      { type: "conversation.resume", cursors: "all" },
      { type: "conversation.resume", cursors: [{ paneId: "p-1" }] },
      { type: "conversation.resume", cursors: [{ paneId: "p-1", cursor: -1 }] },
      { type: "conversation.resume", cursors: Array.from({ length: 33 }, () => ({ paneId: "p", cursor: 0 })) },
    ]) {
      hub.handleMessage(conn, JSON.stringify(body));
    }
    // The socket is reachable from another device; a malformed frame is dropped, never acted on.
    expect(sent).toEqual([]);
  });

  it("forgets a cell once the fleet stops listing it", () => {
    const hub = new StreamHub({ host: HOST });
    hub.publishConversation("p-1", "claude", turnUpdate("a"));
    expect(hub.conversationLogSize()).toBe(1);
    hub.publishFleet([]);
    expect(hub.conversationLogSize()).toBe(0);
  });
});
