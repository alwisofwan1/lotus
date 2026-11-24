import { describe, expect, it, vi } from "vitest";
import { createAgentHeadlineStore } from "../agent-headline-store";

describe("agentHeadlineStore", () => {
  it("shows the first headline a pane produces", () => {
    const store = createAgentHeadlineStore();

    store.record("p-1", { text: "running a command", key: "running a command|" });

    expect(store.get("p-1")).toBe("running a command");
  });

  it("holds the displayed line when only the tense changed", () => {
    // The measured churn: `tool-pre` then `tool-post` seconds apart flips present → past twice per
    // tool call. Same key, so the operator keeps reading one stable line.
    const store = createAgentHeadlineStore();
    store.record("p-1", { text: "running a command", key: "running a command|" });

    store.record("p-1", { text: "ran a command", key: "running a command|" });

    expect(store.get("p-1")).toBe("running a command");
  });

  it("replaces the line when the tool changes", () => {
    const store = createAgentHeadlineStore();
    store.record("p-1", { text: "running a command", key: "running a command|" });

    store.record("p-1", { text: "editing", key: "editing|" });

    expect(store.get("p-1")).toBe("editing");
  });

  it("replaces the line when the area changes", () => {
    const store = createAgentHeadlineStore();
    store.record("p-1", { text: "editing · auth", key: "editing|auth" });

    store.record("p-1", { text: "editing · web", key: "editing|web" });

    expect(store.get("p-1")).toBe("editing · web");
  });

  it("notifies only on a change the operator can see", () => {
    // A repaint per tool-post, on a board of eight agents, for a line that did not change.
    const store = createAgentHeadlineStore();
    store.record("p-1", { text: "running a command", key: "running a command|" });
    const listener = vi.fn();
    store.subscribe(listener);

    store.record("p-1", { text: "ran a command", key: "running a command|" }); // tense only
    expect(listener).not.toHaveBeenCalled();

    store.record("p-1", { text: "editing", key: "editing|" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("advances its version in lockstep with the listeners", () => {
    const store = createAgentHeadlineStore();
    const start = store.version();

    store.record("p-1", { text: "editing", key: "editing|" });
    const afterChange = store.version();
    store.record("p-1", { text: "edited", key: "editing|" }); // tense only

    expect(afterChange).toBeGreaterThan(start);
    expect(store.version()).toBe(afterChange);
  });

  it("keeps panes apart", () => {
    const store = createAgentHeadlineStore();

    store.record("p-1", { text: "editing", key: "editing|" });
    store.record("p-2", { text: "searching", key: "searching|" });

    expect(store.get("p-1")).toBe("editing");
    expect(store.get("p-2")).toBe("searching");
  });

  it("clears a line when the composer has nothing to say", () => {
    // A reopened pane with no tools yet must not keep the previous occupant's title.
    const store = createAgentHeadlineStore();
    store.record("p-1", { text: "editing", key: "editing|" });

    store.record("p-1", { text: null, key: null });

    expect(store.get("p-1")).toBeUndefined();
  });

  it("forgets a pane on clear", () => {
    const store = createAgentHeadlineStore();
    store.record("p-1", { text: "editing", key: "editing|" });

    store.clear("p-1");

    expect(store.get("p-1")).toBeUndefined();
  });

  it("stays silent when clearing a pane it never knew", () => {
    const store = createAgentHeadlineStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.clear("never-seen");

    expect(listener).not.toHaveBeenCalled();
  });

  it("lets a cleared pane accept the same headline again", () => {
    // Clearing must drop the KEY too, or a reopened pane doing identical work would show nothing.
    const store = createAgentHeadlineStore();
    store.record("p-1", { text: "editing", key: "editing|" });
    store.clear("p-1");

    store.record("p-1", { text: "editing", key: "editing|" });

    expect(store.get("p-1")).toBe("editing");
  });
});
