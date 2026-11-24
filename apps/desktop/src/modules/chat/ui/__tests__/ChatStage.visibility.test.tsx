import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The native browser, as calls in order: what the user would see is the last show/hide.
const calls: string[] = [];
type Load = { label: string; phase: "started" | "finished" };
const loadListeners: ((load: Load) => void)[] = [];
vi.mock("@/lib/tauri/browser-preview", () => ({
  openEmbeddedBrowserPreview: vi.fn(async (_url: string, _b: unknown, slot: string) => {
    calls.push(`open ${slot}`);
    return { label: slot, url: _url, reused: false, reachable: true };
  }),
  setEmbeddedBrowserPreviewVisible: vi.fn(async (slot: string, visible: boolean) => {
    calls.push(`${visible ? "show" : "hide"} ${slot}`);
  }),
  captureEmbeddedBrowserPreview: vi.fn(async () => "data:image/png;base64,AA=="),
  syncEmbeddedBrowserPreviewBounds: vi.fn(async () => {}),
  closeEmbeddedBrowserPreview: vi.fn(async () => {}),
  reloadEmbeddedBrowserPreview: vi.fn(async (slot: string) => {
    calls.push(`reload ${slot}`);
  }),
  listenBrowserPreviewLoad: vi.fn(async (onLoad: (load: Load) => void) => {
    loadListeners.push(onLoad);
    return () => loadListeners.splice(loadListeners.indexOf(onLoad), 1);
  }),
  browserPreviewReachable: vi.fn(async () => "ok"),
  browserPreviewSlotSuffix: (slot: string) => `--${slot}`,
  goBackEmbeddedBrowserPreview: vi.fn(async () => {}),
  goForwardEmbeddedBrowserPreview: vi.fn(async () => {}),
  startEmbeddedBrowserAnnotationMode: vi.fn(async () => {}),
  stopEmbeddedBrowserAnnotationMode: vi.fn(async () => {}),
  listenBrowserAnnotationEvents: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/tauri-api", () => ({ openExternalLink: vi.fn(), openPathReference: vi.fn() }));

import { ChatStage, STALL_MS } from "../ChatPreview";
import { SurfaceVisible } from "@/lib/surface-visible";

// jsdom has no layout: the page box and any popup report the rect they are given here.
const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() {} }) as DOMRect;
// Kept off the DOM, so moving a popup is a layout change only, as an exit animation is.
const rects = new WeakMap<Element, [number, number, number, number]>();
let restore: () => void;
beforeEach(() => {
  calls.length = 0;
  loadListeners.length = 0;
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains("chat-stage-page")) return rect(600, 40, 600, 600);
    const el = this as HTMLElement;
    const r = rects.get(el);
    if (r && el.style.display !== "none" && !el.classList.contains("closed")) return rect(...r);
    return rect(0, 0, 0, 0);
  };
  restore = () => (Element.prototype.getBoundingClientRect = original);
});
afterEach(() => {
  restore();
  document.querySelectorAll("[data-rect]").forEach((n) => n.remove());
});

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});
/** Waits past any frame or poll the stage uses to notice a change. */
const settle = () => act(async () => {
  await new Promise((r) => setTimeout(r, 400));
});
/** Whether the native browser is drawn: opening draws it, then the last show or hide wins. */
const shown = (slot: string) => calls.filter((c) => c.endsWith(` ${slot}`) && /^(show|hide|open) /.test(c)).at(-1)?.startsWith("hide") ? "hidden" : "visible";

function stage(threadId: string) {
  return render(<ChatStage threadId={threadId} url="http://localhost:3000" detected={null} onNavigate={() => {}} onPick={() => {}} />);
}

function popup(): HTMLElement {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.dataset.rect = "";
  rects.set(menu, [700, 100, 200, 200]);
  document.body.appendChild(menu);
  return menu;
}

describe("ChatStage bar", () => {
  it("draws its address bar in the Workbench header's slot, and above the page without one", async () => {
    const view = render(
      <aside className="chat-changes">
        <div className="chat-drawer-slot" data-testid="slot" />
        <ChatStage threadId="t-slot" url="http://localhost:3000" detected={null} onNavigate={() => {}} onPick={() => {}} />
      </aside>,
    );
    await flush();
    expect(view.getByTestId("slot").querySelector('input[aria-label="Address"]')).not.toBeNull();
    expect(view.container.querySelectorAll('input[aria-label="Address"]')).toHaveLength(1);
    view.unmount();

    const alone = stage("t-alone");
    await flush();
    expect(alone.container.querySelector('.chat-stage > form input[aria-label="Address"]')).not.toBeNull();
  });
});

describe("ChatStage visibility", () => {
  it("hides when its surface is hidden (another mode, a parked shell) and comes back after", async () => {
    const at = (visible: boolean) => (
      <SurfaceVisible visible>
        <SurfaceVisible visible={visible}>
          <ChatStage threadId="t-mode" url="http://localhost:3000" detected={null} onNavigate={() => {}} onPick={() => {}} />
        </SurfaceVisible>
      </SurfaceVisible>
    );
    const view = render(at(true));
    await flush();
    expect(shown("t-mode")).toBe("visible");

    view.rerender(at(false));
    await flush();
    expect(shown("t-mode")).toBe("hidden");

    view.rerender(at(true));
    await flush();
    expect(shown("t-mode")).toBe("visible");
  });

  it("steps aside for a popup over the page and comes back when it is removed", async () => {
    stage("t-removed");
    await flush();
    expect(shown("t-removed")).toBe("visible");

    const menu = popup();
    await settle();
    expect(shown("t-removed")).toBe("hidden");

    menu.remove();
    await settle();
    expect(shown("t-removed")).toBe("visible");
  });

  it("ignores a menu left open in a mode nobody can see, and shows each new address live", async () => {
    // jsdom has no checkVisibility: stand in for WebKit's, which says no under an inactive mode.
    const proto = Element.prototype as Element & { checkVisibility?: () => boolean };
    proto.checkVisibility = function (this: Element) {
      return !this.closest("[data-unseen]");
    };
    try {
      const mode = document.createElement("div");
      mode.dataset.unseen = "";
      mode.dataset.rect = "";
      document.body.appendChild(mode);
      mode.appendChild(popup());
      const view = stage("t-unseen");
      await settle();
      expect(shown("t-unseen")).toBe("visible");
      view.rerender(<ChatStage threadId="t-unseen" url="https://example.com/" detected={null} onNavigate={() => {}} onPick={() => {}} />);
      await settle();
      expect(shown("t-unseen")).toBe("visible");
      expect(screen.queryByRole("img", { hidden: true })).toBeNull();
    } finally {
      delete (proto as { checkVisibility?: unknown }).checkVisibility;
    }
  });

  it("comes back when a popup closes in place, by style or class, without leaving the DOM", async () => {
    stage("t-style");
    await flush();
    const menu = popup();
    await settle();
    expect(shown("t-style")).toBe("hidden");

    menu.style.display = "none";
    await settle();
    expect(shown("t-style")).toBe("visible");

    menu.style.display = "";
    await settle();
    expect(shown("t-style")).toBe("hidden");

    menu.classList.add("closed");
    await settle();
    expect(shown("t-style")).toBe("visible");
  });

  it("comes back when a popup slides away without any DOM change (an exit animation)", async () => {
    stage("t-moved");
    await flush();
    const menu = popup();
    await settle();
    expect(shown("t-moved")).toBe("hidden");

    // Only layout changes: nothing a MutationObserver sees.
    rects.set(menu, [0, 0, 100, 100]);
    await settle();
    expect(shown("t-moved")).toBe("visible");
  });
});

describe("ChatStage loading", () => {
  it("navigates to a new address in place, never hiding the browser between the two", async () => {
    const view = stage("t-nav");
    await flush();
    calls.length = 0;
    view.rerender(<ChatStage threadId="t-nav" url="https://example.com/" detected={null} onNavigate={() => {}} onPick={() => {}} />);
    await flush();
    expect(calls).toContain("open t-nav");
    expect(calls).not.toContain("hide t-nav");
  });

  it("does not load a chat's page after leaving it while the address was being checked", async () => {
    const { browserPreviewReachable } = await import("@/lib/tauri/browser-preview");
    let answer!: (reach: "ok") => void;
    vi.mocked(browserPreviewReachable).mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const view = stage("t-gone");
    view.unmount();
    await act(async () => answer("ok"));
    await flush();
    expect(calls).not.toContain("open t-gone");
    expect(shown("t-gone")).toBe("hidden");
  });

  it("says at once that a host does not exist, and keeps the last page out of sight", async () => {
    const { browserPreviewReachable } = await import("@/lib/tauri/browser-preview");
    vi.mocked(browserPreviewReachable).mockResolvedValueOnce("unknown-host");
    render(<ChatStage threadId="t-typo" url="https://gogle.invalid/" detected={null} onNavigate={() => {}} onPick={() => {}} />);
    await settle();
    expect(screen.getByText("Can't find gogle.invalid. Check the address or your connection.")).toBeTruthy();
    expect(calls).not.toContain("open t-typo");
    expect(shown("t-typo")).toBe("hidden");
  });

  const emit = (slot: string, phase: Load["phase"]) => act(() => loadListeners.forEach((l) => l({ label: `codechat-browser-preview-embed-main--${slot}`, phase })));
  const reloads = (slot: string) => calls.filter((c) => c === `reload ${slot}`).length;

  it("holds Reload while a page is on its way, so a second press cannot cancel it", async () => {
    stage("t-load");
    await flush();
    const busy = screen.getByRole("button", { name: "Loading" });
    expect(busy).toHaveProperty("disabled", true);
    fireEvent.click(busy);
    expect(reloads("t-load")).toBe(0);

    emit("t-load", "started");
    emit("t-load", "finished");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Loading" }));
    expect(reloads("t-load")).toBe(1);

    // Another chat's page finishing says nothing about this one.
    emit("t-other", "finished");
    expect(screen.getByRole("button", { name: "Loading" })).toBeTruthy();
  });

  it("says a load that never finishes is stalled, and Reload loads it again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stage("t-stall");
      await flush();
      act(() => {
        vi.advanceTimersByTime(STALL_MS);
      });
      expect(screen.getByRole("status").textContent).toBe("Not loading");
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      expect(reloads("t-stall")).toBe(1);
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
