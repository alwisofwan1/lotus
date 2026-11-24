import { describe, it, expect, vi } from "vitest";
import { debounce } from "../utils";

describe("debounce", () => {
  it("delays execution until after the wait period", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it("resets the timer when called again before wait expires", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(80);
    debounced(); // reset
    vi.advanceTimersByTime(80);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it("passes arguments to the debounced function", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced("a", 42);
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledWith("a", 42);

    vi.useRealTimers();
  });
});
