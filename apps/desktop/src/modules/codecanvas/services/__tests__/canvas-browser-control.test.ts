import { describe, expect, it } from "vitest";
import {
  findPairedBrowserNode,
  planCanvasBrowserControl,
} from "../canvas-browser-control";

const terminal = { id: "term-1", type: "terminal", data: {} };
const activeBrowser = { id: "browser-1", type: "browser", data: { state: "active" } };
const disconnectedBrowser = { id: "browser-1", type: "browser", data: { state: "disconnected" } };
const edge = { id: "e1", source: "term-1", target: "browser-1" };

describe("planCanvasBrowserControl", () => {
  it("spawns a paired browser when the terminal has none", () => {
    expect(
      planCanvasBrowserControl(
        { kind: "open-or-focus", terminalId: "term-1", url: "https://youtube.com" },
        { nodes: [terminal], edges: [] },
      ),
    ).toEqual({ kind: "spawn", terminalId: "term-1", url: "https://youtube.com" });
  });

  it("ignores an intent whose terminal is not a node in this project (foreign/stale event)", () => {
    // A browser-open/navigate event for a terminal that belongs to another project must NOT
    // spawn a browser here — that is the cross-project browser-node leak.
    expect(
      planCanvasBrowserControl(
        { kind: "open-or-focus", terminalId: "ghost", url: "https://youtube.com" },
        { nodes: [terminal], edges: [] },
      ),
    ).toEqual({ kind: "ignore", terminalId: "ghost" });
    expect(
      planCanvasBrowserControl(
        { kind: "navigate", terminalId: "ghost", url: "https://youtube.com" },
        { nodes: [terminal], edges: [] },
      ),
    ).toEqual({ kind: "ignore", terminalId: "ghost" });
  });

  it("focuses an existing browser when no URL was requested", () => {
    expect(
      planCanvasBrowserControl(
        { kind: "open-or-focus", terminalId: "term-1" },
        { nodes: [terminal, activeBrowser], edges: [edge] },
      ),
    ).toEqual({ kind: "focus", nodeId: "browser-1" });
  });

  it("activates an existing disconnected browser when a URL was requested", () => {
    expect(
      planCanvasBrowserControl(
        { kind: "open-or-focus", terminalId: "term-1", url: "https://youtube.com" },
        { nodes: [terminal, disconnectedBrowser], edges: [edge] },
      ),
    ).toEqual({ kind: "activate", nodeId: "browser-1", url: "https://youtube.com" });
  });

  it("navigates an existing active browser when a URL was requested", () => {
    expect(
      planCanvasBrowserControl(
        { kind: "open-or-focus", terminalId: "term-1", url: "https://youtube.com" },
        { nodes: [terminal, activeBrowser], edges: [edge] },
      ),
    ).toEqual({
      kind: "navigate",
      nodeId: "browser-1",
      nativeBrowserId: "term-1",
      url: "https://youtube.com",
    });
  });

  it("exposes paired browser lookup for callers that only need identity", () => {
    expect(findPairedBrowserNode("term-1", { nodes: [terminal, activeBrowser], edges: [edge] })).toBe("browser-1");
  });
});
