import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, act } from "@testing-library/react";
import { useEffect, type RefObject } from "react";
import { useNlHintRotator } from "../use-nl-hint-rotator";

function makeSlot(): { lines: [HTMLElement, HTMLElement]; slotRef: RefObject<HTMLElement | null> } {
  const slot = document.createElement("div");
  slot.className = "canvas-nl-hint-slot";
  const lineA = document.createElement("span");
  lineA.className = "canvas-nl-hint-line";
  const lineB = document.createElement("span");
  lineB.className = "canvas-nl-hint-line";
  slot.append(lineA, lineB);
  document.body.appendChild(slot);
  return { lines: [lineA, lineB], slotRef: { current: slot } };
}

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

/** The one line currently in "hold" phase — i.e. what a user actually sees at rest. */
function visibleLine(lines: [HTMLElement, HTMLElement]): HTMLElement {
  const line = lines.find((l) => l.dataset.phase === "hold");
  if (!line) throw new Error("no line is in the hold phase");
  return line;
}

/** Words mode never joins with a space text node — read the phrase back through the word spans. */
function lineWords(line: HTMLElement): string[] {
  return Array.from(line.querySelectorAll(".canvas-nl-hint-word")).map((w) => w.textContent ?? "");
}

describe("useNlHintRotator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockMatchMedia(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("paints the first phrase into the slot on mount, as per-word spans carrying --i", () => {
    const { slotRef, lines } = makeSlot();
    renderHook(() =>
      useNlHintRotator({ slotRef, phrases: ["focus Skye", "arrange the canvas"], suspended: false, pinned: null }),
    );

    const line = visibleLine(lines);
    expect(lineWords(line)).toEqual(["focus", "Skye"]);
    const words = line.querySelectorAll(".canvas-nl-hint-word");
    expect(words[0].getAttribute("style")).toContain("--i: 0");
    expect(words[1].getAttribute("style")).toContain("--i: 1");
  });

  it("rotates to the next phrase after the dwell", () => {
    const { slotRef, lines } = makeSlot();
    renderHook(() => useNlHintRotator({ slotRef, phrases: ["one", "two", "three"], suspended: false, pinned: null }));

    act(() => void vi.advanceTimersByTime(4500));
    expect(lineWords(visibleLine(lines))).toEqual(["two"]);

    act(() => void vi.advanceTimersByTime(4500));
    expect(lineWords(visibleLine(lines))).toEqual(["three"]);

    act(() => void vi.advanceTimersByTime(4500)); // wraps back to the start
    expect(lineWords(visibleLine(lines))).toEqual(["one"]);
  });

  it("the slot is never empty mid-swap — both lines carry real content the instant the swap happens", () => {
    const { slotRef, lines } = makeSlot();
    renderHook(() => useNlHintRotator({ slotRef, phrases: ["one", "two"], suspended: false, pinned: null }));

    act(() => void vi.advanceTimersByTime(4500));

    // the outgoing line keeps its old text (fading out via CSS), the incoming line already has the
    // new text (fading in via CSS) — a single-element implementation would have cleared one of these
    // and left the slot blank for the whole transition; two lines means neither is ever empty.
    for (const line of lines) {
      expect(line.textContent).not.toBe("");
      expect(line.querySelectorAll(".canvas-nl-hint-word").length).toBeGreaterThan(0);
    }
    expect(lines.map((l) => l.dataset.phase).sort()).toEqual(["hold", "out"]);
  });

  it("suspended freezes on the current phrase and resumes from there, not from the start", () => {
    const { slotRef, lines } = makeSlot();
    const { rerender } = renderHook(
      ({ suspended }: { suspended: boolean }) =>
        useNlHintRotator({ slotRef, phrases: ["one", "two"], suspended, pinned: null }),
      { initialProps: { suspended: false } },
    );

    rerender({ suspended: true });
    act(() => void vi.advanceTimersByTime(20_000)); // well past several dwells
    expect(lineWords(visibleLine(lines))).toEqual(["one"]); // frozen

    rerender({ suspended: false });
    act(() => void vi.advanceTimersByTime(4500));
    expect(lineWords(visibleLine(lines))).toEqual(["two"]); // resumed
  });

  it("pinned takes the slot over completely — no rotation runs underneath it", () => {
    const { slotRef, lines } = makeSlot();
    const { rerender } = renderHook(
      ({ pinned }: { pinned: string | null }) =>
        useNlHintRotator({ slotRef, phrases: ["one", "two"], suspended: false, pinned }),
      { initialProps: { pinned: null as string | null } },
    );

    rerender({ pinned: "Listening" });
    expect(lineWords(visibleLine(lines)).join(" ")).toBe("Listening");

    act(() => void vi.advanceTimersByTime(20_000));
    expect(lineWords(visibleLine(lines)).join(" ")).toBe("Listening"); // still pinned, untouched by dwell
  });

  it("clearing pinned resumes rotation from where it was", () => {
    const { slotRef, lines } = makeSlot();
    const { rerender } = renderHook(
      ({ pinned }: { pinned: string | null }) =>
        useNlHintRotator({ slotRef, phrases: ["one", "two", "three"], suspended: false, pinned }),
      { initialProps: { pinned: null as string | null } },
    );

    act(() => void vi.advanceTimersByTime(4500)); // "one" -> "two"
    expect(lineWords(visibleLine(lines))).toEqual(["two"]);

    rerender({ pinned: "Dispatched" });
    expect(lineWords(visibleLine(lines)).join(" ")).toBe("Dispatched");

    rerender({ pinned: null });
    expect(lineWords(visibleLine(lines))).toEqual(["two"]); // back to where it left off, not "one"

    act(() => void vi.advanceTimersByTime(4500));
    expect(lineWords(visibleLine(lines))).toEqual(["three"]); // and rotation continues onward
  });

  it("drops a stale status when it clears while still suspended, instead of leaving it in the slot", () => {
    // The real sequence this guards: a result trace appears, the user clicks into the (still empty)
    // field — suspended — and 4.5s later the trace auto-dismisses. `pinned` goes null while suspended
    // stays true. Freezing without repainting would strand "Dispatched to Rex" in the slot as the
    // prompt until the next blur; the bar this replaced returned to its resting placeholder here.
    const { slotRef, lines } = makeSlot();
    const { rerender } = renderHook(
      ({ suspended, pinned }: { suspended: boolean; pinned: string | null }) =>
        useNlHintRotator({ slotRef, phrases: ["one", "two"], suspended, pinned }),
      { initialProps: { suspended: false, pinned: null as string | null } },
    );

    rerender({ suspended: false, pinned: "Dispatched to Rex" });
    expect(lineWords(visibleLine(lines)).join(" ")).toBe("Dispatched to Rex");

    // user focuses the empty field, THEN the trace times out
    rerender({ suspended: true, pinned: "Dispatched to Rex" });
    rerender({ suspended: true, pinned: null });
    expect(lineWords(visibleLine(lines))).toEqual(["one"]);

    // …and it stays frozen there — suspended still means no rotation
    act(() => void vi.advanceTimersByTime(9000));
    expect(lineWords(visibleLine(lines))).toEqual(["one"]);
  });

  it("re-binds when the slot element is replaced — a live-voice session unmounts the hint", () => {
    // The real sequence: opening a live voice session (⌘⇧L) unmounts the whole hint subtree, and
    // ending it mounts BRAND NEW line spans. The bind effect keys on the ref OBJECT, whose identity
    // never changes, so it never re-ran: the engine kept painting into the detached old spans and the
    // freshly mounted ones stayed empty — the placeholder was gone for good until a reload.
    const { slotRef } = makeSlot();
    const { rerender } = renderHook(
      ({ suspended }: { suspended: boolean }) =>
        useNlHintRotator({ slotRef, phrases: ["one", "two"], suspended, pinned: null }),
      { initialProps: { suspended: false } },
    );
    const before = slotRef.current!.querySelectorAll(".canvas-nl-hint-line");
    expect(lineWords(visibleLine([before[0] as HTMLElement, before[1] as HTMLElement]))).toEqual(["one"]);

    // live session opens: the hint subtree goes away and the bar suspends
    const slot = slotRef.current!;
    slot.innerHTML = "";
    rerender({ suspended: true });

    // …and closes: React mounts a fresh pair of line spans into the same slot
    const freshA = document.createElement("span");
    freshA.className = "canvas-nl-hint-line";
    const freshB = document.createElement("span");
    freshB.className = "canvas-nl-hint-line";
    slot.append(freshA, freshB);
    rerender({ suspended: false });

    // The prompt must come back on the NEW elements, not the detached ones.
    expect(lineWords(visibleLine([freshA, freshB])).join(" ")).not.toBe("");
  });

  it("does no work in a background window and resumes on refocus", () => {
    const { slotRef, lines } = makeSlot();
    renderHook(() => useNlHintRotator({ slotRef, phrases: ["one", "two"], suspended: false, pinned: null }));

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    act(() => void vi.advanceTimersByTime(20_000));
    expect(lineWords(visibleLine(lines))).toEqual(["one"]); // no advance while hidden

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    act(() => void vi.advanceTimersByTime(4500));
    expect(lineWords(visibleLine(lines))).toEqual(["two"]); // resumed
  });

  it("clears the timer and the visibilitychange listener on unmount", () => {
    const { slotRef } = makeSlot();
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() =>
      useNlHintRotator({ slotRef, phrases: ["one", "two"], suspended: false, pinned: null }),
    );

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0); // the rotor's own pending timeout was cleared, nothing left ticking
  });

  it("stretches the dwell under prefers-reduced-motion instead of stopping", () => {
    mockMatchMedia(true);
    const { slotRef, lines } = makeSlot();
    renderHook(() => useNlHintRotator({ slotRef, phrases: ["one", "two"], suspended: false, pinned: null }));

    act(() => void vi.advanceTimersByTime(4500));
    expect(lineWords(visibleLine(lines))).toEqual(["one"]); // the normal dwell alone isn't enough now

    act(() => void vi.advanceTimersByTime(2500)); // 7000ms total
    expect(lineWords(visibleLine(lines))).toEqual(["two"]);
  });

  it("never causes a React re-render — writes go straight to the DOM", () => {
    const { slotRef } = makeSlot();
    // Counted from an effect, not the render body itself — mutating anything during render (even a
    // plain counter) is a side effect React disallows; an effect runs once per commit, which is
    // exactly what "did this hook cause a re-render" needs to observe.
    const renders = { current: 0 };
    function Host() {
      useEffect(() => {
        renders.current += 1;
      });
      useNlHintRotator({ slotRef, phrases: ["one", "two", "three"], suspended: false, pinned: null });
      return null;
    }
    render(<Host />);
    expect(renders.current).toBe(1);

    act(() => void vi.advanceTimersByTime(4500 * 5));
    expect(renders.current).toBe(1); // several ticks later, still exactly the one render/commit
  });
});
