import { describe, expect, it, vi } from "vitest";
import { handleCanvasBrowserApiEvent } from "../canvas-browser-api-bridge";

const terminal = { id: "term-1", type: "terminal", data: {} };
const activeBrowser = { id: "browser-1", type: "browser", data: { parentTerminalId: "term-1", state: "active" } };
const disconnectedBrowser = { id: "browser-1", type: "browser", data: { parentTerminalId: "term-1", state: "disconnected" } };
const edge = { id: "e1", source: "term-1", target: "browser-1" };

describe("handleCanvasBrowserApiEvent", () => {
  it("spawns a paired Browser Node for open when none exists", async () => {
    const spawnBrowserNode = vi.fn(() => "browser-new");
    const navigateBrowser = vi.fn();
    const patchNodeData = vi.fn();

    await handleCanvasBrowserApiEvent(
      {
        kind: "open",
        terminalId: "term-1",
        url: "http://localhost:3000",
        label: "Ghibli Grove Bible",
      },
      { nodes: [terminal], edges: [], spawnBrowserNode, patchNodeData, navigateBrowser },
    );

    expect(spawnBrowserNode).toHaveBeenCalledWith("term-1", "http://localhost:3000");
    expect(navigateBrowser).not.toHaveBeenCalled();
    expect(patchNodeData).toHaveBeenCalledWith("browser-new", {
      label: "Ghibli Grove Bible",
    });
  });

  it("navigates and patches the existing paired Browser Node", async () => {
    const spawnBrowserNode = vi.fn();
    const navigateBrowser = vi.fn(() => Promise.resolve());
    const patchNodeData = vi.fn();

    await handleCanvasBrowserApiEvent(
      { kind: "navigate", terminalId: "term-1", url: "http://localhost:3000/login" },
      { nodes: [terminal, activeBrowser], edges: [edge], spawnBrowserNode, patchNodeData, navigateBrowser },
    );

    expect(spawnBrowserNode).not.toHaveBeenCalled();
    expect(patchNodeData).toHaveBeenCalledWith("browser-1", { url: "http://localhost:3000/login", state: "active" });
    expect(navigateBrowser).toHaveBeenCalledWith("term-1", "http://localhost:3000/login");
  });

  it("reopens an existing paired Browser Node when it is disconnected", async () => {
    const spawnBrowserNode = vi.fn();
    const navigateBrowser = vi.fn(() => Promise.resolve());
    const patchNodeData = vi.fn();

    await handleCanvasBrowserApiEvent(
      {
        kind: "open",
        terminalId: "term-1",
        url: "http://localhost:3000",
        label: "Existing Preview",
      },
      { nodes: [terminal, disconnectedBrowser], edges: [edge], spawnBrowserNode, patchNodeData, navigateBrowser },
    );

    expect(spawnBrowserNode).not.toHaveBeenCalled();
    expect(patchNodeData).toHaveBeenCalledWith("browser-1", {
      url: "http://localhost:3000",
      state: "loading",
      label: "Existing Preview",
    });
    expect(navigateBrowser).not.toHaveBeenCalled();
  });

  it("spawns on navigate when the terminal has no paired Browser Node", async () => {
    const spawnBrowserNode = vi.fn(() => "browser-new");
    const navigateBrowser = vi.fn();
    const patchNodeData = vi.fn();

    await handleCanvasBrowserApiEvent(
      { kind: "navigate", terminalId: "term-1", url: "http://localhost:3000/login" },
      { nodes: [terminal], edges: [], spawnBrowserNode, patchNodeData, navigateBrowser },
    );

    expect(spawnBrowserNode).toHaveBeenCalledWith("term-1", "http://localhost:3000/login");
    expect(navigateBrowser).not.toHaveBeenCalled();
  });
});
