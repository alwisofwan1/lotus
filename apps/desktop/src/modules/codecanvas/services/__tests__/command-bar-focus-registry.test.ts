import { afterEach, describe, expect, it, vi } from "vitest";
import { commandBarFocusRegistry } from "../command-bar-focus-registry";

// The registry is a module-level singleton (mirrors noteSelectionRegistry's map, collapsed to a
// single slot since only one command bar is ever mounted). Every test must leave it empty for the
// next one, so each test captures its own unregister and calls it before finishing.
afterEach(() => {
  document.body.innerHTML = "";
});

function mountFocusableInput(opts: { disabled?: boolean } = {}) {
  const input = document.createElement("textarea");
  input.disabled = !!opts.disabled;
  document.body.appendChild(input);
  return input;
}

describe("commandBarFocusRegistry", () => {
  it("focus() with nothing registered returns false", () => {
    expect(commandBarFocusRegistry.focus()).toBe(false);
  });

  it("focus() calls the registered function and reports true when DOM focus actually moved", () => {
    const input = mountFocusableInput();
    const unregister = commandBarFocusRegistry.register(() => input.focus());
    expect(commandBarFocusRegistry.focus()).toBe(true);
    expect(document.activeElement).toBe(input);
    unregister();
  });

  it("focus() reports false when the registrant's target can't actually take focus (e.g. disabled)", () => {
    // A disabled control can never become document.activeElement — jsdom (like real browsers)
    // silently no-ops .focus() on it, so the before/after comparison sees no change and reports
    // false without the registrant having to track its own success/failure.
    const input = mountFocusableInput({ disabled: true });
    const unregister = commandBarFocusRegistry.register(() => input.focus());
    expect(commandBarFocusRegistry.focus()).toBe(false);
    expect(document.activeElement).not.toBe(input);
    unregister();
  });

  it("a re-register replaces the old handler — focus() calls only the newest one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = commandBarFocusRegistry.register(first);
    const unregisterSecond = commandBarFocusRegistry.register(second);
    commandBarFocusRegistry.focus();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unregisterFirst();
    unregisterSecond();
  });

  it("unregister only removes its own handler — an unmount racing a remount must not clobber the new one", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const unregisterStale = commandBarFocusRegistry.register(stale);
    // Simulate the new instance mounting (and registering) before the old instance's cleanup runs
    // — exactly the ordering a remount can produce.
    const unregisterFresh = commandBarFocusRegistry.register(fresh);
    unregisterStale(); // must be a no-op: `current` is `fresh`, not `stale`, by now
    commandBarFocusRegistry.focus();
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
    unregisterFresh();
  });
});
