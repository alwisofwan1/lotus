import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../../core/api-client.js";
import type { NotificationEvent } from "../../../types/notifications.js";
import { NotificationRelay } from "../notification-relay.js";

/** A stream the test opens, feeds, and ends by hand. */
function controllable() {
  const queue: NotificationEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(event: NotificationEvent) {
      queue.push(event);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    stream: {
      events: async function* () {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      close: () => undefined,
    },
  };
}

function event(title: string): NotificationEvent {
  return {
    kind: "agent_stop",
    agent_type: "claude",
    event: "stop",
    title,
    body: "",
    status: "idle",
    cwd: "/tmp",
    timestamp: 1,
  };
}

describe("NotificationRelay", () => {
  function build(streams: Array<{ events: () => AsyncGenerator<NotificationEvent>; close: () => void }>) {
    const seen: NotificationEvent[] = [];
    const warnings: string[] = [];
    let attaches = 0;
    const api = {
      streamNotifications: vi.fn(() => {
        const next = streams[Math.min(attaches, streams.length - 1)]!;
        attaches += 1;
        return next;
      }),
    } as unknown as ApiClient;

    const relay = new NotificationRelay({
      api,
      onEvent: (e) => {
        seen.push(e);
      },
      warn: (message) => warnings.push(message),
      sleep: async () => undefined,
      retryMs: 0,
    });
    return { relay, seen, warnings, attaches: () => attaches };
  }

  it("forwards every event in order", async () => {
    const a = controllable();
    const h = build([a.stream]);
    h.relay.start();

    a.push(event("first"));
    a.push(event("second"));
    await vi.waitFor(() => expect(h.seen).toHaveLength(2));
    h.relay.stop();

    expect(h.seen.map((e) => ("title" in e ? e.title : ""))).toEqual(["first", "second"]);
  });

  /// The regression this module exists for. One interruption used to end forwarding for
  /// the life of the runtime — silently, since it was only a warning.
  it("re-attaches after the stream ends cleanly", async () => {
    const first = controllable();
    const second = controllable();
    const h = build([first.stream, second.stream]);
    h.relay.start();

    first.end();
    await vi.waitFor(() => expect(h.attaches()).toBeGreaterThan(1));

    second.push(event("after the reconnect"));
    await vi.waitFor(() => expect(h.seen).toHaveLength(1));
    h.relay.stop();

    expect(h.warnings).toContain("mobile.notifications.stream_ended");
  });

  it("re-attaches after the stream throws", async () => {
    const failing = {
      events: async function* (): AsyncGenerator<NotificationEvent> {
        throw new Error("desktop went away");
      },
      close: () => undefined,
    };
    const good = controllable();
    const h = build([failing, good.stream]);
    h.relay.start();

    await vi.waitFor(() => expect(h.attaches()).toBeGreaterThan(1));
    good.push(event("recovered"));
    await vi.waitFor(() => expect(h.seen).toHaveLength(1));
    h.relay.stop();
  });

  /// Ordering inside `stop` matters: the flag has to be set before the stream is
  /// closed, or the loop reads its own close as an interruption and reconnects to a
  /// desktop the adapter is walking away from.
  it("stops for good, and does not treat its own close as an interruption", async () => {
    const a = controllable();
    const h = build([a.stream]);
    h.relay.start();
    await vi.waitFor(() => expect(h.attaches()).toBe(1));

    h.relay.stop();
    a.end();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(h.attaches()).toBe(1);
  });

  it("can be started again after stopping, which is what the Mobile Access toggle does",
    async () => {
      const a = controllable();
      const h = build([a.stream]);
      h.relay.start();
      await vi.waitFor(() => expect(h.attaches()).toBe(1));
      h.relay.stop();

      h.relay.start();
      await vi.waitFor(() => expect(h.attaches()).toBe(2));
      h.relay.stop();
    });
});
