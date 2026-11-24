import { describe, expect, it, vi } from "vitest";
import { awaitSessionId } from "@/modules/tasks/services/await-session";

function pane(sequence: (string | null)[]) {
  let index = 0;
  const listeners = new Set<() => void>();
  return {
    deps: {
      peek: () => sequence[Math.min(index, sequence.length - 1)],
      subscribe: (_paneId: string, onChange: () => void) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
    },
    /** Move to the next value and tell whoever is waiting. */
    advance: () => {
      index += 1;
      listeners.forEach((listener) => listener());
    },
    listeners,
  };
}

describe("waiting for a pane's session", () => {
  it("answers at once when the pane already has one", async () => {
    const { deps } = pane(["sess_1"]);

    await expect(awaitSessionId("pane_1", deps)).resolves.toBe("sess_1");
  });

  it("waits for the session that arrives a moment later", async () => {
    // `addPane` returns before the pane has mounted and made its PTY. Writing during that beat is
    // writing to nothing.
    const p = pane([null, "sess_2"]);
    const pending = awaitSessionId("pane_1", p.deps, { timeoutMs: 1000 });

    p.advance();

    await expect(pending).resolves.toBe("sess_2");
  });

  it("gives up rather than hanging, and says so with null", async () => {
    const p = pane([null]);

    await expect(awaitSessionId("pane_1", p.deps, { timeoutMs: 20 })).resolves.toBeNull();
  });

  it("lets go of the subscription however it ends", async () => {
    // A listener left behind on a pane that never started is a leak that outlives the pane.
    const p = pane([null]);

    await awaitSessionId("pane_1", p.deps, { timeoutMs: 20 });

    expect(p.listeners.size).toBe(0);
  });

  it("stops when the caller aborts", async () => {
    const p = pane([null]);
    const controller = new AbortController();
    const pending = awaitSessionId("pane_1", p.deps, { timeoutMs: 5000, signal: controller.signal });

    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(p.listeners.size).toBe(0);
  });
});
