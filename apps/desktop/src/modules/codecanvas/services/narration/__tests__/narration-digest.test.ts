import { describe, expect, it } from "vitest";
import { summarizeFlush } from "../narration-digest";
import type { ProjectFlush } from "../narration-router";
import type { NarrationEvent } from "../narration-event";

const NOW = 1_700_000_000_000;

const ev = (tag: string, paneId = "canvas:projA:a1"): NarrationEvent => ({
  kind: "tool_post",
  tag,
  neutral: "",
  paneId,
  ts: NOW,
});

const flush = (events: NarrationEvent[]): ProjectFlush => ({
  projectId: "projA",
  paneIds: [...new Set(events.map((e) => e.paneId))],
  events,
});

describe("summarizeFlush — the no-model floor", () => {
  it("counts repeated work instead of listing it", () => {
    const line = summarizeFlush(flush([ev("tool_post_edit"), ev("tool_post_edit"), ev("tool_post_edit")]), {});

    expect(line).toBe("Three edits.");
  });

  it("says 'a' rather than '1' for a single item", () => {
    expect(summarizeFlush(flush([ev("tool_post_grep")]), {})).toBe("A search.");
  });

  it("orders by how much of the work each kind was", () => {
    const line = summarizeFlush(flush([ev("tool_post_edit"), ev("tool_post_grep"), ev("tool_post_edit")]), {});

    expect(line).toBe("Two edits, a search.");
  });

  it("names the project when the listener needs to know where", () => {
    expect(summarizeFlush(flush([ev("tool_post_edit")]), { label: "lotus" })).toBe("Lotus: an edit.");
  });

  it("says so when more than one agent contributed", () => {
    // Otherwise a pooled update reads as one agent doing twice the work.
    const line = summarizeFlush(
      flush([ev("tool_post_edit", "canvas:projA:a1"), ev("tool_post_edit", "canvas:projA:a2")]),
      {},
    );

    expect(line).toBe("Two edits across two agents.");
  });

  it("still says something for a tool it has never heard of", () => {
    // A new tool must degrade to a vague word, never to silence — this function IS the fallback
    // for when no model is reachable.
    expect(summarizeFlush(flush([ev("tool_post_somethingnew")]), {})).toBe("An operation.");
  });

  it("returns null for an empty flush rather than an empty sentence", () => {
    expect(summarizeFlush(flush([]), {})).toBeNull();
  });
});
