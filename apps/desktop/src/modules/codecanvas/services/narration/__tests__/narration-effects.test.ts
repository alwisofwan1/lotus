import { describe, expect, it } from "vitest";
import { narrationEffectsFor } from "../narration-effects";
import type { NarrationEvent } from "../narration-event";
import type { RoutingDecision } from "../narration-router";

const NOW = 1_700_000_000_000;

const ev = (over: Partial<NarrationEvent> = {}): NarrationEvent => ({
  kind: "tool_pre",
  tag: "tool_edit",
  neutral: "src/auth.ts",
  paneId: "canvas:projA:node-9",
  ts: NOW,
  ...over,
});

const decision = (over: Partial<RoutingDecision> = {}): RoutingDecision => ({
  action: "speak",
  labelPrefix: "",
  ...over,
});

describe("narrationEffectsFor", () => {
  it("says nothing and touches nothing for a dropped event", () => {
    const effects = narrationEffectsFor(decision({ action: "drop" }), ev());

    expect(effects).toEqual({ shouldSpeak: false, labelPrefix: "", focusNodeId: null, pending: false });
  });

  it("speaks a routine event without moving the camera", () => {
    // Yanking the viewport on every tool call would make the canvas unusable. Only something that
    // actually needs the user earns a camera move.
    const effects = narrationEffectsFor(decision(), ev());

    expect(effects.shouldSpeak).toBe(true);
    expect(effects.focusNodeId).toBeNull();
  });

  it("focuses the node for a pierce, and names who it was", () => {
    const effects = narrationEffectsFor(
      decision({ labelPrefix: "Nova: " }),
      ev({ kind: "tool_post", tag: "tool_post_failure", neutral: "exit 1" }),
    );

    expect(effects.labelPrefix).toBe("Nova: ");
    // The pane id is project-scoped; the canvas focus command takes the bare node id.
    expect(effects.focusNodeId).toBe("node-9");
  });

  it("focuses a failure even when nobody named it", () => {
    // With one agent working there is nobody to disambiguate from, so the router speaks the
    // failure with NO prefix. Inferring "this is urgent" from the prefix therefore misses the
    // single-agent case — which is the common one. Urgency comes from the tag, not the label.
    const effects = narrationEffectsFor(decision({ labelPrefix: "" }), ev({ kind: "tool_post", tag: "tool_post_failure", neutral: "exit 1" }));

    expect(effects.focusNodeId).toBe("node-9");
    expect(effects.shouldSpeak).toBe(true);
  });

  it("marks a deferred event as pending instead of speaking it", () => {
    // The ambient badge is the whole point of the second channel: the user can SEE an agent is
    // working without being told about it.
    const effects = narrationEffectsFor(decision({ action: "defer_to_digest" }), ev());

    expect(effects).toEqual({ shouldSpeak: false, labelPrefix: "", focusNodeId: null, pending: true });
  });

  it("still focuses on a pierce that carries no text", () => {
    // Nothing to say, but the canvas can still point at the agent that needs a human. Whether a
    // line exists is Layer 5's call now; this module only decides that it MAY speak.
    const effects = narrationEffectsFor(
      decision({ labelPrefix: "Nova: " }),
      ev({ kind: "tool_post", tag: "tool_post_failure", neutral: "" }),
    );

    expect(effects.focusNodeId).toBe("node-9");
  });

  it("handles an unscoped pane id rather than inventing a node", () => {
    const effects = narrationEffectsFor(
      decision({ labelPrefix: "Nova: " }),
      ev({ paneId: "plain-node", kind: "tool_post", tag: "tool_post_failure", neutral: "boom" }),
    );

    expect(effects.focusNodeId).toBe("plain-node");
  });
});
