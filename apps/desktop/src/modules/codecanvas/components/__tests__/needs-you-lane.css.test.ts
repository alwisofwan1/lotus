import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(
  resolve(process.cwd(), "src/styles/canvas/agent-node-graph.css"),
  "utf8",
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.[\]="-]/g, (c) => `\\${c}`);
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

describe("the needs-you lane styling", () => {
  it("exists at all", () => {
    expect(() => rule(".canvas-needs-you")).not.toThrow();
  });

  it("cannot scroll — that is the whole reason it is not a bucket in the inbox", () => {
    // `.canvas-inbox` is `flex: 0 1 clamp(7rem,32vh,18rem)` with `overflow: hidden` and a scrolling
    // child; a pinned group inside it scrolls away on a busy board. This lane must never shrink or
    // scroll, so it takes its natural height and keeps it.
    const lane = rule(".canvas-needs-you");
    expect(lane).toMatch(/flex:\s*0 0 auto/);
    expect(lane).not.toMatch(/overflow-y:\s*(auto|scroll)/);
  });

  it("carries the attention violet, and the same value the card badge ships", () => {
    // One state, one colour, across the card and the sidebar. Drifting these apart is how an
    // operator learns to distrust both.
    expect(rule(".canvas-needs-you")).toContain("oklch(0.78 0.16 295");
  });

  it("does not animate", () => {
    // A spinner over "answer me" is the lie this whole plan removes.
    const lane = rule(".canvas-needs-you");
    const dot = rule(".canvas-needs-you-dot");
    expect(lane).not.toMatch(/animation/);
    expect(dot).not.toMatch(/animation/);
  });

  it("recedes when empty instead of holding a lit strip open all day", () => {
    expect(() => rule('.canvas-needs-you[data-empty="true"]')).not.toThrow();
  });

  it("keeps its rows at the inbox row height, so the two lists read as one panel", () => {
    expect(rule(".canvas-needs-you-row")).toMatch(/padding:\s*0\.28rem 0\.4rem/);
  });

  describe("route A — violet means exactly one thing", () => {
    it("hands the inbox title the muted token the sidebar's own label already uses", () => {
      // The decorative violet steps aside for the semantic one. `--canvas-sidebar-muted` is what
      // `.canvas-sidebar-label` ("PROCESSES") uses, so the inbox gets MORE consistent, not less.
      expect(rule(".canvas-inbox-title")).toContain("--canvas-sidebar-muted");
      expect(rule(".canvas-inbox-title")).not.toContain("196, 181, 253");
    });

    it("takes the violet out of the inbox scrollbar too", () => {
      // Chrome, not meaning — and it sits inches from the lane.
      const scroll = rule(".canvas-inbox-scroll");
      expect(scroll).not.toContain("196, 181, 253");
    });
  });
});
