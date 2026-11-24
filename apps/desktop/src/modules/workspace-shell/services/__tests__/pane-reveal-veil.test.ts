import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaneRevealVeil,
  PANE_VEIL_AFTER_REDRAW_MS,
  PANE_VEIL_MAX_MS,
  PANE_VEIL_MIN_MS,
  PANE_VEIL_QUIET_MS,
} from "@/modules/workspace-shell/services/pane-reveal-veil";

describe("createPaneRevealVeil", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const create = (onReveal: () => void) => createPaneRevealVeil(onReveal, () => Date.now());

  it("reveals after the minimum when no output arrives", () => {
    const onReveal = vi.fn();
    create(onReveal).start();

    vi.advanceTimersByTime(PANE_VEIL_MIN_MS - 1);
    expect(onReveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("holds a relaunched agent's pane until its first output has gone quiet", () => {
    const onReveal = vi.fn();
    const veil = create(onReveal);
    veil.start({ awaitOutput: true, quietMs: 1000, maxMs: 8000 });

    vi.advanceTimersByTime(1200); // the agent prints nothing while it boots
    expect(onReveal).not.toHaveBeenCalled();
    veil.noteOutput();
    vi.advanceTimersByTime(800); // a mid-replay gap
    veil.noteOutput();
    vi.advanceTimersByTime(999);
    expect(onReveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("waits for the repaint output to go quiet", () => {
    const onReveal = vi.fn();
    const veil = create(onReveal);
    veil.start();

    vi.advanceTimersByTime(PANE_VEIL_MIN_MS - 10);
    veil.noteOutput();
    vi.advanceTimersByTime(PANE_VEIL_QUIET_MS - 1);
    expect(onReveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("never stays veiled past the cap, even with nonstop output", () => {
    const onReveal = vi.fn();
    const veil = create(onReveal);
    veil.start();

    for (let t = 0; t < PANE_VEIL_MAX_MS; t += 20) {
      veil.noteOutput();
      vi.advanceTimersByTime(20);
    }
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("restarts the wait when started again, and reveals once", () => {
    const onReveal = vi.fn();
    const veil = create(onReveal);
    veil.start();
    vi.advanceTimersByTime(PANE_VEIL_MIN_MS - 20);
    veil.start();
    vi.advanceTimersByTime(PANE_VEIL_MIN_MS - 1);
    expect(onReveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PANE_VEIL_MAX_MS);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("does nothing after dispose", () => {
    const onReveal = vi.fn();
    const veil = create(onReveal);
    veil.start();
    veil.dispose();
    vi.advanceTimersByTime(PANE_VEIL_MAX_MS);
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("holds a returning pane until its redraw is done, however long the rebuild takes", () => {
    const onReveal = vi.fn();
    const veil = create(onReveal);
    veil.start({ awaitRedraw: true });

    // The rebuild runs past the minimum before the step even goes out.
    vi.advanceTimersByTime(PANE_VEIL_MIN_MS + 50);
    expect(onReveal).not.toHaveBeenCalled();
    veil.noteRedraw("pending");
    vi.advanceTimersByTime(120);
    expect(onReveal).not.toHaveBeenCalled();

    veil.noteRedraw("done");
    vi.advanceTimersByTime(PANE_VEIL_AFTER_REDRAW_MS - 1);
    expect(onReveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("waits for the repaint output after the redraw to go quiet", () => {
    const onReveal = vi.fn();
    const veil = create(onReveal);
    veil.start({ awaitRedraw: true });
    veil.noteRedraw("pending");
    vi.advanceTimersByTime(PANE_VEIL_MIN_MS);
    veil.noteRedraw("done");

    vi.advanceTimersByTime(PANE_VEIL_AFTER_REDRAW_MS - 10);
    veil.noteOutput();
    vi.advanceTimersByTime(PANE_VEIL_QUIET_MS - 1);
    expect(onReveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("still lifts at the cap when the awaited redraw never comes", () => {
    const onReveal = vi.fn();
    create(onReveal).start({ awaitRedraw: true });

    vi.advanceTimersByTime(PANE_VEIL_MAX_MS - 1);
    expect(onReveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });
});
