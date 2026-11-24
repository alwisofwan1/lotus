import { afterEach, describe, expect, it } from "vitest";
import { runThemeTransition, themeRevealOrigin, whenThemeTransitionSettles } from "@/lib/design-system/theme-transition";

/** A view transition the browser skipped: the update still runs, `ready` and `finished` reject. */
function installSkippingViewTransitions() {
  (document as unknown as { startViewTransition: unknown }).startViewTransition = (update: () => void) => {
    update();
    const skipped = () => Promise.reject(new DOMException("Transition was skipped", "AbortError"));
    return { updateCallbackDone: Promise.resolve(), ready: skipped(), finished: skipped(), skipTransition: () => {} };
  };
}

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe("runThemeTransition", () => {
  it("applies the theme and raises no unhandled rejection when the browser skips the crossfade", async () => {
    installSkippingViewTransitions();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let applied = false;

    try {
      runThemeTransition(() => {
        applied = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(applied).toBe(true);
    expect(unhandled).toEqual([]);
  });
});

/** A view transition that runs: the update applies now, each `finished` settles when its finisher is called. */
function installRunningViewTransitions() {
  const finishers: Array<() => void> = [];
  (document as unknown as { startViewTransition: unknown }).startViewTransition = (update: () => void) => {
    update();
    const finished = new Promise<void>((resolve) => finishers.push(resolve));
    return { updateCallbackDone: Promise.resolve(), ready: Promise.resolve(), finished, skipTransition: () => {} };
  };
  return finishers;
}

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runThemeTransition reveal", () => {
  afterEach(() => {
    const root = document.documentElement;
    root.removeAttribute("data-theme-reveal");
    ["--ds-reveal-x", "--ds-reveal-y", "--ds-reveal-r"].forEach((name) => root.style.removeProperty(name));
  });

  it("grows the new theme from the origin, sized to reach the farthest corner, and clears the flag when done", async () => {
    const finishers = installRunningViewTransitions();
    const finish = () => finishers.forEach((f) => f());
    const root = document.documentElement;
    let flagDuringUpdate: string | null = null;

    runThemeTransition(() => {
      flagDuringUpdate = root.getAttribute("data-theme-reveal");
    }, { x: 10, y: 20 });

    expect(flagDuringUpdate).toBe("");
    expect(root.style.getPropertyValue("--ds-reveal-x")).toBe("10px");
    expect(root.style.getPropertyValue("--ds-reveal-y")).toBe("20px");
    const farthest = Math.hypot(window.innerWidth - 10, window.innerHeight - 20);
    expect(root.style.getPropertyValue("--ds-reveal-r")).toBe(`${Math.ceil(farthest)}px`);

    finish();
    await flushPromises();
    expect(root.hasAttribute("data-theme-reveal")).toBe(false);
  });

  it("suppresses CSS transitions while the theme applies, and lifts that once it has", () => {
    installRunningViewTransitions();
    const root = document.documentElement;
    let flagDuringUpdate: string | null = null;
    runThemeTransition(() => {
      flagDuringUpdate = root.getAttribute("data-theme-switching");
    }, { x: 1, y: 1 });
    expect(flagDuringUpdate).toBe("");
    expect(root.hasAttribute("data-theme-switching")).toBe(false);
  });

  it("crossfades without an origin", () => {
    installRunningViewTransitions();
    runThemeTransition(() => {});
    expect(document.documentElement.hasAttribute("data-theme-reveal")).toBe(false);
  });

  it("keeps the flag while a newer reveal runs, even when the older one finishes first", async () => {
    const finishers = installRunningViewTransitions();
    runThemeTransition(() => {}, { x: 1, y: 1 });
    runThemeTransition(() => {}, { x: 2, y: 2 });
    finishers[0]();
    await flushPromises();
    expect(document.documentElement.hasAttribute("data-theme-reveal")).toBe(true);
    finishers[1]();
    await flushPromises();
    expect(document.documentElement.hasAttribute("data-theme-reveal")).toBe(false);
  });
});

describe("themeRevealOrigin", () => {
  const element = { getBoundingClientRect: () => ({ left: 100, top: 40, width: 60, height: 20 }) } as unknown as Element;

  it("starts at the pointer for a mouse click", () => {
    expect(themeRevealOrigin(element, { clientX: 7, clientY: 9, detail: 1 })).toEqual({ x: 7, y: 9 });
  });

  it("starts at the element's centre for a keyboard press", () => {
    expect(themeRevealOrigin(element, { clientX: 0, clientY: 0, detail: 0 })).toEqual({ x: 130, y: 50 });
    expect(themeRevealOrigin(element)).toEqual({ x: 130, y: 50 });
  });
});

describe("whenThemeTransitionSettles", () => {
  it("waits for the running switch to finish, and does not reject when it is skipped", async () => {
    const finishers = installRunningViewTransitions();
    runThemeTransition(() => {}, { x: 1, y: 1 });
    let settled = false;
    void whenThemeTransitionSettles().then(() => {
      settled = true;
    });
    await flushPromises();
    expect(settled).toBe(false);
    finishers[0]();
    await flushPromises();
    expect(settled).toBe(true);

    installSkippingViewTransitions();
    runThemeTransition(() => {});
    await expect(whenThemeTransitionSettles()).resolves.toBeUndefined();
  });
});
