import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { NotificationEvent } from "../../../../types/notifications.js";
import { DeviceStore } from "../../device-store.js";
import type { PushMessage, PushSender, SendOutcome } from "../fcm-sender.js";
import { AskLedger, wakeKindFor } from "../push-policy.js";
import { PushService } from "../push-service.js";

function hookEvent(overrides: Partial<Record<string, unknown>> = {}): NotificationEvent {
  return {
    kind: "agent_stop",
    pane_id: "p-1",
    agent_type: "claude",
    event: "tool-pre",
    tool_target: "rm src/legacy/shim.ts",
    title: "Bash",
    body: "Do you want to run this command?",
    status: "needs-input",
    cwd: "/Users/op/code/lotus",
    timestamp: 1_785_664_800_000,
    ...overrides,
  } as NotificationEvent;
}

/** Records what it was asked to ring, and answers however the test says. */
class FakeSender implements PushSender {
  readonly sent: string[] = [];
  readonly messages: PushMessage[] = [];
  outcome: SendOutcome = "sent";
  throws: Error | null = null;

  async send(registrationToken: string, message: PushMessage): Promise<SendOutcome> {
    this.sent.push(registrationToken);
    this.messages.push(message);
    if (this.throws !== null) throw this.throws;
    return this.outcome;
  }
}

describe("PushService", () => {
  let store: DeviceStore;
  let sender: FakeSender;
  let logs: string[];
  let clock: number;
  let viewing: Set<string>;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "lotus-push-"));
    clock = 1_785_664_800_000;
    store = new DeviceStore(join(dir, "devices.json"), () => clock);
    sender = new FakeSender();
    logs = [];
    viewing = new Set();
  });

  function service(): PushService {
    return new PushService({
      devices: store,
      sender,
      log: (message) => logs.push(message),
      now: () => clock,
      fleetSnapshot: async () => [
        { paneId: "p-1", workspaceId: "ws", agentType: "claude", title: "Atlas", status: "live", isAlive: true, sessionId: "s" },
      ],
      viewing: () => viewing,
    });
  }

  function pairWithPush(name: string, pushToken: string): string {
    const issued = store.issue(name);
    store.setPushToken(issued.deviceId, pushToken);
    return issued.deviceId;
  }

  describe("which events are worth waking a phone for", () => {
    it("wakes for an agent that stopped and is waiting for a human", () => {
      expect(wakeKindFor(hookEvent(), new AskLedger())).toBe("attention");
    });

    it("does not wake for a tool step that is still running", () => {
      // Every hook event arrives as the same `agent_stop` variant, including
      // `tool-pre` and `session-start`, both of which report `running`. Waking on the
      // variant alone would be a notification per tool call.
      const ledger = new AskLedger();
      expect(wakeKindFor(hookEvent({ status: "running" }), ledger)).toBeNull();
      expect(wakeKindFor(hookEvent({ event: "session-start", status: "running" }), ledger)).toBeNull();
    });

    // `issues/04` (2026-08-27): a finish is news only when the ask came from the phone.
    // An agent the operator started at the desk finishing is not a reason to buzz a pocket.
    it("wakes for a finish only when the ask was sent from a phone", () => {
      const finished = hookEvent({ event: "stop", status: "idle" });
      expect(wakeKindFor(finished, new AskLedger())).toBeNull();

      const ledger = new AskLedger();
      ledger.record("p-1");
      expect(wakeKindFor(finished, ledger)).toBe("finished");
    });

    it("spends the ask on one finish, so a desk-side follow-up stays quiet", () => {
      const ledger = new AskLedger();
      ledger.record("p-1");
      wakeKindFor(hookEvent({ event: "stop", status: "idle" }), ledger);

      expect(wakeKindFor(hookEvent({ event: "stop", status: "idle" }), ledger)).toBeNull();
    });

    it("matches the bare uuid the spawn route answered with against a prefixed pane id", () => {
      // `/m/cells` returns `paneId: "<uuid>"`; hook events carry whatever the desktop
      // prefixes it with. Neither side should have to learn the other's spelling.
      const ledger = new AskLedger();
      ledger.record("abc-123");
      expect(wakeKindFor(hookEvent({ pane_id: "pane:abc-123", event: "stop", status: "idle" }), ledger)).toBe("finished");
    });

    it("does not wake for a stalled cell", () => {
      // A stalled cell may be an agent thinking hard, and silence from a runner that
      // reports no turn cannot be interpreted (`MVP.md` §2). Guessing would train the
      // operator to ignore the channel.
      const stalled: NotificationEvent = {
        kind: "cell_stalled",
        pane_id: "p-1",
        workspace_id: "ws-1",
        session_id: "s-1",
        idle_ms: 300_000,
        timestamp: clock,
      };

      expect(wakeKindFor(stalled, new AskLedger())).toBeNull();
    });

    it("sends nothing at all when the event does not qualify", async () => {
      pairWithPush("Pixel", "tok-fcm");

      await service().notify(hookEvent({ status: "running" }));

      expect(sender.sent).toEqual([]);
    });
  });

  describe("what the wake-up says", () => {
    it("names the agent and says `needs you`, nothing from the prompt or the command", async () => {
      pairWithPush("Pixel", "tok-fcm");

      await service().notify(hookEvent({ user_prompt: "rm -rf the legacy shims" }));

      expect(sender.messages).toEqual([
        { kind: "attention", title: "Atlas", body: "needs you", paneId: "p-1" },
      ]);
      expect(JSON.stringify(sender.messages)).not.toContain("legacy");
    });

    it("says `finished` for an ask the phone sent, `stopped with an error` when it failed", async () => {
      pairWithPush("Pixel", "tok-fcm");
      const svc = service();
      svc.recordAsk("p-1");
      await svc.notify(hookEvent({ event: "stop", status: "idle" }));
      svc.recordAsk("p-1");
      await svc.notify(hookEvent({ event: "stop", status: "error" }));

      expect(sender.messages.map((m) => m.body)).toEqual(["finished", "stopped with an error"]);
      expect(sender.messages.every((m) => m.kind === "finished")).toBe(true);
    });

    it("still rings when the fleet cannot be read — the name is decoration, the wake-up is the point", async () => {
      pairWithPush("Pixel", "tok-fcm");
      const svc = new PushService({
        devices: store,
        sender,
        log: (message) => logs.push(message),
        now: () => clock,
        fleetSnapshot: async () => {
          throw new Error("desktop 503");
        },
      });

      await svc.notify(hookEvent());

      expect(sender.messages.map((m) => m.title)).toEqual(["An agent"]);
      expect(logs).toContain("mobile.push.fleet_unavailable");
    });

    it("falls back to a generic name for a pane the fleet no longer lists", async () => {
      pairWithPush("Pixel", "tok-fcm");

      await service().notify(hookEvent({ pane_id: "p-gone" }));

      expect(sender.messages[0]!.title).toBe("An agent");
    });
  });

  describe("a phone already looking at the agent", () => {
    it("is not rung — the screen says what the banner would", async () => {
      const watching = pairWithPush("Pixel", "tok-a");
      pairWithPush("iPad", "tok-b");
      viewing.add(watching);

      await service().notify(hookEvent());

      expect(sender.sent).toEqual(["tok-b"]);
      expect(logs).toContain("mobile.push.viewing");
    });
  });

  describe("who gets rung", () => {
    it("every device that registered a token", async () => {
      pairWithPush("Pixel", "tok-a");
      pairWithPush("iPad", "tok-b");

      await service().notify(hookEvent());

      expect(sender.sent.sort()).toEqual(["tok-a", "tok-b"]);
    });

    it("not a device that never registered one", async () => {
      store.issue("Laptop without push");

      await service().notify(hookEvent());

      expect(sender.sent).toEqual([]);
    });

    it("not a device whose credential has aged out", async () => {
      pairWithPush("Pixel", "tok-a");
      // Past the 72-hour TTL. Waking that phone delivers it to a screen that can only
      // ask for a new pairing, so the wake-up is noise.
      clock += 73 * 60 * 60 * 1000;

      await service().notify(hookEvent());

      expect(sender.sent).toEqual([]);
    });

    it("not a revoked device — the token dies with the pairing", async () => {
      const deviceId = pairWithPush("Stolen phone", "tok-a");
      store.revoke(deviceId);

      await service().notify(hookEvent());

      expect(sender.sent).toEqual([]);
    });
  });

  describe("keeping the channel honest", () => {
    it("drops a registration token FCM says is dead", async () => {
      const deviceId = pairWithPush("Uninstalled", "tok-dead");
      sender.outcome = "unregistered";

      await service().notify(hookEvent());
      expect(store.withPushToken()).toEqual([]);
      // And the device itself survives: the app was removed, the pairing was not.
      expect(store.list().find((d) => d.deviceId === deviceId)?.push).toBe(false);
    });

    it("keeps the token when FCM is merely unavailable", async () => {
      pairWithPush("Pixel", "tok-a");
      sender.outcome = "unavailable";

      await service().notify(hookEvent());

      // Throttling is not a dead phone. Dropping here would silently disable push
      // until the operator noticed and re-registered.
      expect(store.withPushToken()).toHaveLength(1);
    });

    it("a thrown error is contained, so the live socket is never held hostage", async () => {
      pairWithPush("Pixel", "tok-a");
      sender.throws = new Error("network down");

      await expect(service().notify(hookEvent())).resolves.toBeUndefined();
      expect(logs).toContain("mobile.push.failed");
    });

    it("throttles a chatty fleet instead of draining a battery", async () => {
      pairWithPush("Pixel", "tok-a");
      const push = service();

      for (let i = 0; i < 10; i += 1) {
        await push.notify(hookEvent());
      }

      // Six in a burst, then a token every 30s. The cap is a transport guard, not the
      // notification policy `issues/04` owes us.
      expect(sender.sent).toHaveLength(6);
      expect(logs.filter((l) => l === "mobile.push.throttled")).toHaveLength(4);
    });

    it("lets a wake-up through again once the bucket refills", async () => {
      pairWithPush("Pixel", "tok-a");
      const push = service();
      for (let i = 0; i < 7; i += 1) await push.notify(hookEvent());
      expect(sender.sent).toHaveLength(6);

      clock += 30_000;
      await push.notify(hookEvent());

      expect(sender.sent).toHaveLength(7);
    });

    it("never writes the registration token to a log line", async () => {
      pairWithPush("Pixel", "tok-secret-capability");

      await service().notify(hookEvent());

      expect(logs.join(" ")).not.toContain("tok-secret-capability");
    });
  });
});
