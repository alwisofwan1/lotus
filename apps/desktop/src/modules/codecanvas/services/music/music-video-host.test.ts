import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIDEO_HOST_ID,
  ensureVideoHost,
  flushVideoHostLayoutForTests,
  getVideoSlotOwner,
  registerVideoSlot,
  resetVideoHostForTests,
  setVideoHostActive,
  subscribeVideoSlotOwner,
} from "./music-video-host";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** jsdom has no layout, so every slot's box is stated explicitly. */
function boxed(rect: Rect, className = "slot"): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  element.getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

function host(): HTMLElement {
  return document.getElementById(VIDEO_HOST_ID) as HTMLElement;
}

function hostStyle(): string {
  return host().getAttribute("style") ?? "";
}

beforeEach(() => {
  resetVideoHostForTests();
  window.innerWidth = 1440;
  window.innerHeight = 900;
});

afterEach(() => {
  resetVideoHostForTests();
  document.body.innerHTML = "";
});

describe("the video host element", () => {
  it("is created once and reused, whoever asks", () => {
    const first = ensureVideoHost();
    const second = ensureVideoHost();

    expect(first).toBe(second);
    expect(document.querySelectorAll(`#${VIDEO_HOST_ID}`)).toHaveLength(1);
    expect(first.parentElement).toBe(host());
    expect(host().parentElement).toBe(document.body);
  });

  it("parks off-screen instead of hiding, so playback is never suspended", () => {
    ensureVideoHost();
    flushVideoHostLayoutForTests();

    expect(hostStyle()).toContain("translate3d(-10000px, 0, 0)");
    expect(hostStyle()).not.toContain("display: none");
    expect(getVideoSlotOwner()).toBeNull();
  });
});

describe("slot ownership", () => {
  it("gives a canvas node the video and hands it back to the dock when the node goes", () => {
    ensureVideoHost();
    setVideoHostActive(true);
    const dock = boxed({ left: 1200, top: 700, width: 96, height: 54 });
    const releaseDock = registerVideoSlot(dock, { kind: "dock" });

    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBe("dock");

    const node = boxed({ left: 300, top: 200, width: 420, height: 236 });
    const releaseNode = registerVideoSlot(node, { kind: "node" });
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBe("node");
    expect(hostStyle()).toContain("translate3d(300px, 200px, 0)");
    expect(hostStyle()).toContain("width: 420px");

    // The project switch: the node unmounts and releases its slot.
    releaseNode();
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBe("dock");
    expect(hostStyle()).toContain("translate3d(1200px, 700px, 0)");

    releaseDock();
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBeNull();
  });

  it("moves the video between slots without ever re-parenting the iframe", () => {
    const player = ensureVideoHost();
    setVideoHostActive(true);
    player.src = "https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1";

    const node = boxed({ left: 10, top: 20, width: 300, height: 170 });
    const releaseNode = registerVideoSlot(node, { kind: "node" });
    flushVideoHostLayoutForTests();
    const dock = boxed({ left: 1200, top: 700, width: 96, height: 54 });
    registerVideoSlot(dock, { kind: "dock" });
    releaseNode();
    flushVideoHostLayoutForTests();

    // The only thing that changed is a transform: same element, same document
    // position, same URL — which is why the audio survives the move.
    expect(player.parentElement).toBe(host());
    expect(host().parentElement).toBe(document.body);
    expect(player.src).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1");
    expect(getVideoSlotOwner()).toBe("dock");
  });

  it("skips a slot that is too small to be worth showing (LOD glyph, collapsed node)", () => {
    ensureVideoHost();
    setVideoHostActive(true);
    const collapsed = boxed({ left: 40, top: 40, width: 12, height: 8 });
    registerVideoSlot(collapsed, { kind: "node" });
    const dock = boxed({ left: 1200, top: 700, width: 96, height: 54 });
    registerVideoSlot(dock, { kind: "dock" });

    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBe("dock");
  });

  it("ignores a slot whose element has left the document", () => {
    ensureVideoHost();
    setVideoHostActive(true);
    const node = boxed({ left: 100, top: 100, width: 300, height: 170 });
    registerVideoSlot(node, { kind: "node" });
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBe("node");

    node.remove();
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBeNull();
  });

  it("notifies subscribers when ownership changes", () => {
    ensureVideoHost();
    setVideoHostActive(true);
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeVideoSlotOwner(() => seen.push(getVideoSlotOwner()));

    const dock = boxed({ left: 1200, top: 700, width: 96, height: 54 });
    const release = registerVideoSlot(dock, { kind: "dock" });
    flushVideoHostLayoutForTests();
    release();
    flushVideoHostLayoutForTests();

    expect(seen).toEqual(["dock", null]);
    unsubscribe();
  });
});

describe("clipping", () => {
  it("clips to the canvas pane so a node dragged past the edge cannot bleed video", () => {
    ensureVideoHost();
    setVideoHostActive(true);
    const pane = boxed({ left: 0, top: 100, width: 1440, height: 800 }, "react-flow");
    const node = boxed({ left: 200, top: 60, width: 400, height: 220 });
    registerVideoSlot(node, { kind: "node", clipTo: pane, borderRadius: "12px" });

    flushVideoHostLayoutForTests();
    // 40px of the node sits above the pane's top edge → clipped off the host's top.
    expect(hostStyle()).toContain("clip-path: inset(40px 0px 0px 0px round 12px)");
    expect(getVideoSlotOwner()).toBe("node");
  });

  it("drops a slot scrolled out of the canvas entirely, falling back to the dock", () => {
    ensureVideoHost();
    setVideoHostActive(true);
    const pane = boxed({ left: 0, top: 100, width: 1440, height: 800 }, "react-flow");
    const offscreen = boxed({ left: 200, top: -400, width: 400, height: 220 });
    registerVideoSlot(offscreen, { kind: "node", clipTo: pane });
    const dock = boxed({ left: 1200, top: 700, width: 96, height: 54 });
    registerVideoSlot(dock, { kind: "dock" });

    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBe("dock");
  });

  it("stacks the dock slot above the dock surface, and the node slot below canvas chrome", () => {
    ensureVideoHost();
    setVideoHostActive(true);
    const dock = boxed({ left: 1200, top: 700, width: 96, height: 54 });
    const releaseDock = registerVideoSlot(dock, { kind: "dock" });
    flushVideoHostLayoutForTests();
    expect(hostStyle()).toContain("z-index: 111");

    const node = boxed({ left: 300, top: 200, width: 420, height: 236 });
    registerVideoSlot(node, { kind: "node" });
    releaseDock();
    flushVideoHostLayoutForTests();
    expect(hostStyle()).toContain("z-index: 2");
  });
});

describe("activity", () => {
  it("parks the host and reports no owner while nothing is loaded", () => {
    ensureVideoHost();
    const node = boxed({ left: 300, top: 200, width: 420, height: 236 });
    registerVideoSlot(node, { kind: "node" });

    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBeNull();
    expect(hostStyle()).toContain("opacity: 0");

    setVideoHostActive(true);
    flushVideoHostLayoutForTests();
    expect(getVideoSlotOwner()).toBe("node");
    expect(hostStyle()).toContain("opacity: 1");

    setVideoHostActive(false);
    expect(getVideoSlotOwner()).toBeNull();
    expect(hostStyle()).toContain("translate3d(-10000px, 0, 0)");
  });

  it("wakes the follow loop only for scrolls that can move a slot, and never while parked", () => {
    // Queue frames and drain them by hand, so the loop idles out within the test.
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    const drain = () => {
      while (frames.length > 0) frames.shift()!(0);
    };
    try {
      ensureVideoHost();
      drain();
      const panel = document.createElement("div");
      document.body.appendChild(panel);
      const node = boxed({ left: 300, top: 200, width: 420, height: 236 });
      panel.appendChild(node);
      const afterCreate = raf.mock.calls.length; // creation parks the host once
      registerVideoSlot(node, { kind: "node" });
      panel.dispatchEvent(new Event("scroll"));
      expect(raf.mock.calls.length).toBe(afterCreate); // inactive: no layout loop at all

      setVideoHostActive(true);
      drain();
      const afterActivate = raf.mock.calls.length;
      expect(afterActivate).toBeGreaterThan(0);

      const terminal = document.createElement("div");
      document.body.appendChild(terminal);
      terminal.dispatchEvent(new Event("scroll"));
      expect(raf.mock.calls.length).toBe(afterActivate); // an unrelated scroller (a terminal)

      panel.dispatchEvent(new Event("scroll"));
      expect(raf.mock.calls.length).toBeGreaterThan(afterActivate); // the slot's own scroller
    } finally {
      raf.mockRestore();
    }
  });
});
