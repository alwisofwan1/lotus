import { beforeEach, describe, expect, it } from "vitest";

import type { Device } from "../device-store.js";
import type { ServerEvent } from "../events.js";
import { StreamHub } from "../stream-hub.js";
import type { StreamSocket } from "../stream-hub.js";

function fakeSocket(): StreamSocket & { sent: ServerEvent[]; closed: boolean } {
  const sent: ServerEvent[] = [];
  return {
    sent,
    closed: false,
    send(data: string) {
      sent.push(JSON.parse(data) as ServerEvent);
    },
    close() {
      this.closed = true;
    },
  };
}

function device(id: string): Device {
  return {
    deviceId: id,
    name: id,
    pairedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    hardExpiresAt: Number.MAX_SAFE_INTEGER,
    push: false,
  };
}

describe("StreamHub", () => {
  let hub: StreamHub;

  beforeEach(() => {
    hub = new StreamHub({
      host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
    });
  });

  describe("attach", () => {
    it("sends hello as the very first frame so the app never has to ask", () => {
      const socket = fakeSocket();

      hub.attach(socket, device("dev_a"));

      expect(socket.sent[0]).toMatchObject({
        type: "hello",
        hostId: "mac",
        hostLabel: "MacBook",
        mode: "client",
        hostCaps: { protocol: 1 },
      });
    });

    it("counts connections so a caller can tell whether anyone is listening", () => {
      hub.attach(fakeSocket(), device("dev_a"));
      hub.attach(fakeSocket(), device("dev_b"));

      expect(hub.connectionCount()).toBe(2);
    });
  });

  describe("detach", () => {
    it("stops delivering to a detached connection", () => {
      const socket = fakeSocket();
      const conn = hub.attach(socket, device("dev_a"));
      const before = socket.sent.length;

      hub.detach(conn);
      hub.publishNotification({ kind: "agent-stop" } as never);

      expect(socket.sent).toHaveLength(before);
      expect(hub.connectionCount()).toBe(0);
    });
  });

  describe("output routing", () => {
    it("delivers cell output only to connections subscribed to that pane", () => {
      const watcher = fakeSocket();
      const bystander = fakeSocket();
      const a = hub.attach(watcher, device("dev_a"));
      hub.attach(bystander, device("dev_b"));

      hub.handleMessage(a, JSON.stringify({ type: "subscribe", paneId: "p-1" }));
      hub.publishOutput("p-1", "hello", 5);

      expect(watcher.sent.at(-1)).toEqual({
        type: "cell.output",
        paneId: "p-1",
        chunk: "hello",
        byteOffset: 5,
      });
      expect(bystander.sent.some((e) => e.type === "cell.output")).toBe(false);
    });

    it("drops the previous subscription when a connection switches pane", () => {
      const socket = fakeSocket();
      const conn = hub.attach(socket, device("dev_a"));

      hub.handleMessage(conn, JSON.stringify({ type: "subscribe", paneId: "p-1" }));
      hub.handleMessage(conn, JSON.stringify({ type: "subscribe", paneId: "p-2" }));
      hub.publishOutput("p-1", "stale", 1);

      expect(socket.sent.some((e) => e.type === "cell.output")).toBe(false);
    });

    it("stops delivering after a null subscribe", () => {
      const socket = fakeSocket();
      const conn = hub.attach(socket, device("dev_a"));

      hub.handleMessage(conn, JSON.stringify({ type: "subscribe", paneId: "p-1" }));
      hub.handleMessage(conn, JSON.stringify({ type: "subscribe", paneId: null }));
      hub.publishOutput("p-1", "ignored", 1);

      expect(socket.sent.some((e) => e.type === "cell.output")).toBe(false);
    });

    it("reports the panes anyone is watching so the caller can stop idle streams", () => {
      const a = hub.attach(fakeSocket(), device("dev_a"));
      const b = hub.attach(fakeSocket(), device("dev_b"));

      hub.handleMessage(a, JSON.stringify({ type: "subscribe", paneId: "p-1" }));
      hub.handleMessage(b, JSON.stringify({ type: "subscribe", paneId: "p-1" }));

      expect(hub.watchedPanes()).toEqual(["p-1"]);

      hub.detach(a);
      expect(hub.watchedPanes()).toEqual(["p-1"]);
      hub.detach(b);
      expect(hub.watchedPanes()).toEqual([]);
    });
  });

  describe("broadcast", () => {
    it("names the devices whose socket is tailing a pane, for the push service to spare", () => {
      const a = fakeSocket();
      const b = fakeSocket();
      const connA = hub.attach(a, device("dev_a"));
      hub.attach(b, device("dev_b"));
      hub.handleMessage(connA, JSON.stringify({ type: "subscribe", paneId: "p-1" }));

      expect([...hub.devicesViewing("p-1")]).toEqual(["dev_a"]);
      expect(hub.devicesViewing("p-2").size).toBe(0);
    });

    it("sends fleet changes to every connection", () => {
      const a = fakeSocket();
      const b = fakeSocket();
      hub.attach(a, device("dev_a"));
      hub.attach(b, device("dev_b"));

      hub.publishFleet([]);

      expect(a.sent.at(-1)).toEqual({ type: "fleet.changed", cells: [] });
      expect(b.sent.at(-1)).toEqual({ type: "fleet.changed", cells: [] });
    });

    /// Per-device delivery, which is what a freshly attached phone needs: it gets the
    /// current fleet without every other device being sent it again.
    ///
    /// This used to be asserted with `chat.token`, an event that was removed on
    /// 2026-08-06 because nothing ever published it. The capability is real and used
    /// (`index.ts` sends the snapshot to one device on attach), so the test kept its
    /// subject and changed its vehicle.
    it("delivers only to the device named, not to every connection", () => {
      const asker = fakeSocket();
      const other = fakeSocket();
      hub.attach(asker, device("dev_a"));
      hub.attach(other, device("dev_b"));
      const before = other.sent.length;

      hub.sendToDevice("dev_a", { type: "fleet.changed", cells: [] });

      expect(asker.sent.at(-1)).toMatchObject({ type: "fleet.changed" });
      expect(other.sent).toHaveLength(before);
    });
  });

  describe("inbound handling", () => {
    it("answers a resume request by reporting where the caller was served from", () => {
      const socket = fakeSocket();
      const conn = hub.attach(socket, device("dev_a"));
      const served: Array<{ paneId: string; fromByte: number }> = [];
      hub.onResume((req) => {
        served.push(req);
      });

      hub.handleMessage(conn, JSON.stringify({ type: "resume", paneId: "p-1", fromByte: 42 }));

      expect(served).toEqual([{ paneId: "p-1", fromByte: 42 }]);
    });

    it("ignores a malformed frame without closing the connection", () => {
      const socket = fakeSocket();
      const conn = hub.attach(socket, device("dev_a"));
      const before = socket.sent.length;

      hub.handleMessage(conn, "not json");
      hub.handleMessage(conn, JSON.stringify({ type: "drop-tables" }));

      expect(socket.closed).toBe(false);
      expect(socket.sent).toHaveLength(before);
    });

    it("treats a ping as liveness only — no reply frame, no state change", () => {
      const socket = fakeSocket();
      const conn = hub.attach(socket, device("dev_a"));
      const before = socket.sent.length;

      hub.handleMessage(conn, JSON.stringify({ type: "ping" }));

      expect(socket.sent).toHaveLength(before);
      expect(hub.connectionCount()).toBe(1);
    });
  });

  describe("closeAll", () => {
    it("closes every socket and empties the hub", () => {
      const a = fakeSocket();
      hub.attach(a, device("dev_a"));

      hub.closeAll();

      expect(a.closed).toBe(true);
      expect(hub.connectionCount()).toBe(0);
    });
  });

  /**
   * Checked as it is said, not only against recordings. The suite holds every producer to the
   * grammar over a captured turn; this is what hears the run nobody captured — `bb` validates
   * at runtime for the same reason, and keeps the timeline moving either way.
   */
  describe("the grammar, on the live lane", () => {
    it("reports a part filed under a turn nobody opened, and still sends it", () => {
      const broken: Array<{ paneId: string; rule: string }> = [];
      const checked = new StreamHub({
        host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
        onGrammarViolation: (paneId, violation) => broken.push({ paneId, rule: violation.rule }),
      });
      const socket = fakeSocket();
      checked.attach(socket, device("dev_a"));

      checked.publishConversation("p-1", "claude", {
        kind: "part",
        turnId: "t-nobody-opened",
        part: { id: "a", ts: 1, seq: 0, provenance: "native", type: "user_message", text: "go" },
      });

      expect(broken).toEqual([{ paneId: "p-1", rule: "turn/known" }]);
      // Withholding the step would punish the operator for the producer's mistake.
      expect(socket.sent.some((f) => (f as { type?: string }).type === "conversation")).toBe(true);
    });

    it("says nothing about a lane that behaves", () => {
      const broken: string[] = [];
      const checked = new StreamHub({
        host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
        onGrammarViolation: (_paneId, violation) => broken.push(violation.rule),
      });
      checked.publishConversation("p-1", "claude", { kind: "turn", turn: { turnId: "t-1", startedAt: 1 } });
      checked.publishConversation("p-1", "claude", {
        kind: "part",
        turnId: "t-1",
        part: { id: "a", ts: 1, seq: 0, provenance: "native", type: "user_message", text: "go" },
      });

      expect(broken).toEqual([]);
    });

    it("forgets a cell that has left the fleet", () => {
      const broken: string[] = [];
      const checked = new StreamHub({
        host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
        onGrammarViolation: (_paneId, violation) => broken.push(violation.rule),
      });
      checked.publishConversation("p-1", "claude", { kind: "turn", turn: { turnId: "t-1", startedAt: 1 } });
      checked.publishFleet([]);
      // The turn it knew went with the cell, so a part naming it is now unplaceable — which is
      // the honest answer for a pane id that will never be reused.
      checked.publishConversation("p-1", "claude", {
        kind: "part",
        turnId: "t-1",
        part: { id: "a", ts: 1, seq: 0, provenance: "native", type: "user_message", text: "go" },
      });
      expect(broken).toEqual(["turn/known"]);
    });
  });
});

