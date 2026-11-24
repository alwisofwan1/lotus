import { describe, expect, it, vi } from "vitest";
import {
  HIDDEN_BROWSER_PANE_BOUNDS,
  disposeBrowserPaneRuntime,
  normalizeBrowserPaneUrl,
  syncBrowserPaneRuntime,
  type BrowserPaneNativeAdapter,
} from "@/modules/codespace/services/browser-pane-runtime";

function createAdapter(): BrowserPaneNativeAdapter {
  return {
    ensure: vi.fn(() => Promise.resolve()),
    syncBounds: vi.fn(() => Promise.resolve()),
    setVisible: vi.fn(() => Promise.resolve()),
    navigate: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    back: vi.fn(() => Promise.resolve()),
    forward: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(() => Promise.resolve()),
  };
}

function createHost(bounds: Partial<DOMRect> = {}): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  Object.defineProperty(host, "offsetParent", {
    configurable: true,
    value: document.body,
  });
  host.getBoundingClientRect = vi.fn(() => ({
    x: bounds.x ?? 12,
    y: bounds.y ?? 24,
    left: bounds.left ?? 12,
    top: bounds.top ?? 24,
    right: bounds.right ?? 412,
    bottom: bounds.bottom ?? 324,
    width: bounds.width ?? 400,
    height: bounds.height ?? 300,
    toJSON: () => ({}),
  } as DOMRect));
  return host;
}

describe("browser-pane-runtime", () => {
  it("normalizes browser pane URLs consistently", () => {
    expect(normalizeBrowserPaneUrl(" localhost:5173 ")).toBe("http://localhost:5173");
    expect(normalizeBrowserPaneUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(normalizeBrowserPaneUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeBrowserPaneUrl("example.com")).toBe("https://example.com");
    expect(normalizeBrowserPaneUrl("   ")).toBe("");
  });

  it("ensures and shows a visible browser pane", async () => {
    const adapter = createAdapter();
    const host = createHost();

    const snapshot = await syncBrowserPaneRuntime({
      adapter,
      label: "pane-1",
      url: "https://example.com",
      enabled: true,
      host,
    });

    expect(snapshot.visible).toBe(true);
    expect(adapter.ensure).toHaveBeenCalledWith("pane-1", "https://example.com", {
      x: 12,
      y: 24,
      width: 400,
      height: 300,
    });
    expect(adapter.syncBounds).toHaveBeenCalledWith("pane-1", {
      x: 12,
      y: 24,
      width: 400,
      height: 300,
    });
    expect(adapter.setVisible).toHaveBeenCalledWith("pane-1", true);
  });

  it("hides without ensuring when a browser pane is disabled", async () => {
    const adapter = createAdapter();
    const host = createHost();

    const snapshot = await syncBrowserPaneRuntime({
      adapter,
      label: "pane-1",
      url: "https://example.com",
      enabled: false,
      host,
    });

    expect(snapshot.visible).toBe(false);
    expect(adapter.ensure).not.toHaveBeenCalled();
    expect(adapter.syncBounds).toHaveBeenCalledWith("pane-1", HIDDEN_BROWSER_PANE_BOUNDS);
    expect(adapter.setVisible).toHaveBeenCalledWith("pane-1", false);
  });

  it("treats an empty URL as a hidden browser pane", async () => {
    const adapter = createAdapter();
    const host = createHost();

    const snapshot = await syncBrowserPaneRuntime({
      adapter,
      label: "pane-1",
      url: "",
      enabled: true,
      host,
    });

    expect(snapshot.enabled).toBe(false);
    expect(adapter.ensure).not.toHaveBeenCalled();
    expect(adapter.syncBounds).toHaveBeenCalledWith("pane-1", HIDDEN_BROWSER_PANE_BOUNDS);
    expect(adapter.setVisible).toHaveBeenCalledWith("pane-1", false);
  });

  it("hides or destroys according to pane persistence", async () => {
    const adapter = createAdapter();

    await disposeBrowserPaneRuntime({
      adapter,
      label: "keep",
      persistence: "keep-alive-hidden",
    });
    await disposeBrowserPaneRuntime({
      adapter,
      label: "destroy",
      persistence: "destroy-on-unmount",
    });

    expect(adapter.syncBounds).toHaveBeenCalledWith("keep", HIDDEN_BROWSER_PANE_BOUNDS);
    expect(adapter.setVisible).toHaveBeenCalledWith("keep", false);
    expect(adapter.destroy).toHaveBeenCalledWith("destroy");
  });
});
