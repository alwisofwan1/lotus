import { describe, expect, it } from "vitest";
import { TerminalV2RendererRehydrationStore } from "../terminal-v2-renderer-rehydration-store";

describe("TerminalV2RendererRehydrationStore", () => {
  it("drains hidden pane output through a per-pane output ring", () => {
    const store = new TerminalV2RendererRehydrationStore();
    const chunks: string[] = [];

    store.appendPaneOutput("pane-1", "hello");
    store.appendPaneOutput("pane-1", " world");
    store.drainPaneOutput("pane-1", (chunk) => chunks.push(chunk));

    expect(chunks).toEqual(["hello world"]);
    expect(store.hasPaneOutput("pane-1")).toBe(false);
  });
});
