import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  closeTerminalSession: vi.fn(),
}));
vi.mock("@/modules/codespace/services/terminal-activity-registry", () => ({
  resetTerminalActivity: vi.fn(),
}));

import { useCanvasNodes } from "../useCanvasNodes";
import type { CanvasSnapshot } from "../../types/canvas";

const BASE_SNAP: CanvasSnapshot = {
  schemaVersion: 1,
  id: "default",
  rootDir: "/app",
  nodes: [
    {
      type: "terminal",
      id: "term-1",
      position: { x: 0, y: 0 },
      size: { w: 560, h: 360 },
      cwd: "/app",
      terminalNumber: 1,
      assignedWorktree: null,
    },
  ],
  edges: [],
};

describe("useCanvasNodes — browser node ops", () => {
  it("spawnBrowserNode creates a browser node wired with browser-spawn edge", () => {
    const { result } = renderHook(() =>
      useCanvasNodes({ current: "/app" }, vi.fn()),
    );
    act(() => result.current.loadSnapshot(BASE_SNAP));

    act(() => result.current.spawnBrowserNode("term-1", "http://localhost:3000"));

    const browserNode = result.current.nodes.find((n) => n.type === "browser");
    expect(browserNode).toBeDefined();
    expect(browserNode?.data?.parentTerminalId).toBe("term-1");
    expect(browserNode?.data?.url).toBe("http://localhost:3000");

    const spawnEdge = result.current.edges.find(
      (e) => e.source === "term-1" && e.target === browserNode?.id,
    );
    expect(spawnEdge).toBeDefined();
    expect((spawnEdge as { data?: { wireKind?: string } })?.data?.wireKind).toBe("browser-spawn");
  });

  it("spawnBrowserNode enforces one-to-one: second call focuses existing node", () => {
    const { result } = renderHook(() =>
      useCanvasNodes({ current: "/app" }, vi.fn()),
    );
    act(() => result.current.loadSnapshot(BASE_SNAP));

    act(() => result.current.spawnBrowserNode("term-1", "http://localhost:3000"));
    const countAfterFirst = result.current.nodes.filter((n) => n.type === "browser").length;

    act(() => result.current.spawnBrowserNode("term-1", "http://localhost:4000"));
    const countAfterSecond = result.current.nodes.filter((n) => n.type === "browser").length;

    expect(countAfterFirst).toBe(1);
    expect(countAfterSecond).toBe(1);
  });

  it("closeBrowserNode removes the browser node and its spawn edge", () => {
    const { result } = renderHook(() =>
      useCanvasNodes({ current: "/app" }, vi.fn()),
    );
    act(() => result.current.loadSnapshot(BASE_SNAP));
    act(() => result.current.spawnBrowserNode("term-1", "http://localhost:3000"));

    const browserNode = result.current.nodes.find((n) => n.type === "browser")!;
    act(() => result.current.closeBrowserNode(browserNode.id));

    expect(result.current.nodes.find((n) => n.type === "browser")).toBeUndefined();
    expect(
      result.current.edges.find((e) => e.source === "term-1" && e.target === browserNode.id),
    ).toBeUndefined();
  });

  it("browser counter increments per spawn and is restored from snapshot", () => {
    const { result } = renderHook(() =>
      useCanvasNodes({ current: "/app" }, vi.fn()),
    );
    act(() => result.current.loadSnapshot(BASE_SNAP));

    act(() => result.current.spawnBrowserNode("term-1", "http://a.com"));
    const first = result.current.nodes.find((n) => n.type === "browser");
    expect(first?.data?.browserNumber).toBe(1);

    act(() => result.current.closeBrowserNode(first!.id));

    const snap2: CanvasSnapshot = {
      ...BASE_SNAP,
      browserCounter: 5,
      nodes: [
        ...BASE_SNAP.nodes,
        {
          type: "browser" as const,
          id: "br-existing",
          position: { x: 200, y: 0 },
          size: { w: 640, h: 480 },
          parentTerminalId: "term-1",
          url: "http://saved.com",
          state: "disconnected" as const,
          browserNumber: 5,
        },
      ],
    };
    act(() => result.current.loadSnapshot(snap2));

    // spawn a new terminal so we can spawn a browser from it
    act(() => result.current.addTerminalNode());
    const term2 = result.current.nodes.find(
      (n) => n.type === "terminal" && n.id !== "term-1",
    )!;
    act(() => result.current.spawnBrowserNode(term2.id, "http://b.com"));
    const newBrowser = result.current.nodes.find(
      (n) => n.type === "browser" && n.id !== "br-existing",
    );
    expect(newBrowser?.data?.browserNumber).toBe(6);
  });
});
