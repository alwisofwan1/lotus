import { describe, expect, it, vi } from "vitest";
import { createParkRetryController } from "./canvas-park-retry";

function fakeClock() {
  const timers: Array<{ id: number; fn: () => void; at: number }> = [];
  let now = 0;
  let seq = 1;
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = seq++;
      timers.push({ id, fn, at: now + ms });
      return id;
    },
    clearTimeout: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    advance: (ms: number) => {
      now += ms;
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      for (const t of due) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
    pending: () => timers.length,
  };
}

describe("createParkRetryController", () => {
  it("re-issues the park on the backoff schedule until it succeeds", () => {
    const clock = fakeClock();
    const reissue = vi.fn();
    const ctrl = createParkRetryController({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    ctrl.onFailure(reissue); // schedule retry at 50ms
    expect(reissue).not.toHaveBeenCalled();

    clock.advance(50);
    expect(reissue).toHaveBeenCalledTimes(1);

    ctrl.onSuccess(); // park landed — no more retries pending
    clock.advance(1000);
    expect(reissue).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });

  it("gives up after the schedule is exhausted and reports it once", () => {
    const clock = fakeClock();
    const reissue = vi.fn();
    const onGiveUp = vi.fn();
    const ctrl = createParkRetryController({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onGiveUp,
    });

    // Simulate a park that keeps failing: each reissue fails again.
    reissue.mockImplementation(() => ctrl.onFailure(reissue));

    ctrl.onFailure(reissue); // attempt 0 -> 50ms
    clock.advance(50); // retry 1 fails -> 150ms
    clock.advance(150); // retry 2 fails -> 400ms
    clock.advance(400); // retry 3 fails -> exhausted

    expect(reissue).toHaveBeenCalledTimes(3);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("cancel() drops a pending retry and resets the attempt budget", () => {
    const clock = fakeClock();
    const reissue = vi.fn();
    const ctrl = createParkRetryController({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    ctrl.onFailure(reissue); // schedule at 50
    ctrl.cancel(); // newer bounds supersede
    clock.advance(1000);
    expect(reissue).not.toHaveBeenCalled();

    // Budget reset: a fresh failure starts again at the first backoff step.
    ctrl.onFailure(reissue);
    clock.advance(50);
    expect(reissue).toHaveBeenCalledTimes(1);
  });
});
