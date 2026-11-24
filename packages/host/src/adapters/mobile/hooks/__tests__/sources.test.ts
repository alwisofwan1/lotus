import { describe, expect, it } from "vitest";

import { CliSources } from "../sources.js";

/**
 * Slice 3.1. Deliberately **not** part of `HookTurns`, and the difference is the lifetime.
 *
 * A turn ages out after 30 minutes because "is it waiting" goes stale — a `needs-input` from
 * this morning is not a question anyone still holds. Where a CLI keeps its transcript does not
 * go stale: the file is durable, the CLI wrote it, and it outlives both the turn and this host.
 * Sharing the TTL would erase a readable history for the crime of being quiet.
 */
describe("CliSources", () => {
  it("remembers where a pane's CLI keeps its history", () => {
    const sources = new CliSources();

    sources.record("pane-7", { transcriptPath: "/t/a.jsonl", sessionId: "s-1", cwd: "/p" });

    expect(sources.sourceOf("pane-7")).toEqual({
      transcriptPath: "/t/a.jsonl",
      sessionId: "s-1",
      cwd: "/p",
    });
  });

  it("says nothing about a pane no hook has spoken for", () => {
    expect(new CliSources().sourceOf("pane-nobody")).toBeUndefined();
  });

  /**
   * A resumed session writes a new file, and the newest event is the one that knows. Overwriting
   * is the point — the alternative is serving yesterday's conversation for today's cell.
   */
  it("takes the newest word for a pane", () => {
    const sources = new CliSources();

    sources.record("pane-7", { transcriptPath: "/t/old.jsonl" });
    sources.record("pane-7", { transcriptPath: "/t/new.jsonl" });

    expect(sources.sourceOf("pane-7")?.transcriptPath).toBe("/t/new.jsonl");
  });

  /** Quiet is not stale. The whole reason this is not in `HookTurns`. */
  it("does not age out", () => {
    let now = 0;
    const sources = new CliSources(() => now);

    sources.record("pane-7", { transcriptPath: "/t/a.jsonl" });
    now = 90 * 24 * 60 * 60 * 1000;

    expect(sources.sourceOf("pane-7")?.transcriptPath).toBe("/t/a.jsonl");
  });

  /**
   * The capability, not yet a behaviour: nothing calls this today, exactly as nothing calls
   * `HookTurns.forget`. Both maps are bounded and pane ids are uuids that are never reused, so
   * the cost of not calling it is memory alone — recorded here rather than left to look wired.
   */
  it("can forget a pane", () => {
    const sources = new CliSources();
    sources.record("pane-7", { transcriptPath: "/t/a.jsonl" });

    sources.forget("pane-7");

    expect(sources.sourceOf("pane-7")).toBeUndefined();
  });

  /**
   * Nothing ages these out, so something else has to bound them. A host that has spawned
   * thousands of cells over months must not carry every one of them.
   */
  it("evicts the least recently spoken-for pane once full", () => {
    let now = 0;
    const sources = new CliSources(() => now, 2);

    sources.record("a", { transcriptPath: "/a.jsonl" });
    now = 1;
    sources.record("b", { transcriptPath: "/b.jsonl" });
    now = 2;
    sources.record("c", { transcriptPath: "/c.jsonl" });

    expect(sources.sourceOf("a")).toBeUndefined();
    expect(sources.sourceOf("b")?.transcriptPath).toBe("/b.jsonl");
    expect(sources.sourceOf("c")?.transcriptPath).toBe("/c.jsonl");
  });
});
