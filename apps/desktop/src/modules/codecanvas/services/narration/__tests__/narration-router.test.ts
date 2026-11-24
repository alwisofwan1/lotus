import { describe, expect, it } from "vitest";
import { CHANNEL_IDLE_FLUSH_MS, CHANNEL_MAX_PENDING, createNarrationRouter } from "../narration-router";
import type { NarrationEvent } from "../narration-event";

const NOW = 1_700_000_000_000;

const ev = (over: Partial<NarrationEvent> = {}): NarrationEvent => ({
  kind: "tool_pre",
  tag: "tool_edit",
  neutral: "",
  paneId: "canvas:projA:a1",
  ts: NOW,
  ...over,
});

const router = () => createNarrationRouter({ resolveName: (paneId) => paneId.split(":").pop() ?? paneId });

describe("narration router — one agent working alone", () => {
  it("speaks routine work", () => {
    expect(router().classify(ev(), NOW).action).toBe("speak");
  });

  it("adds no name prefix — there is nobody to confuse it with", () => {
    expect(router().classify(ev(), NOW).labelPrefix).toBe("");
  });
});

describe("narration router — several agents at once", () => {
  const twoAgents = () => {
    const r = router();
    r.classify(ev({ paneId: "canvas:projA:a1" }), NOW);
    r.classify(ev({ paneId: "canvas:projB:b1", ts: NOW + 10 }), NOW + 10);
    return r;
  };

  it("holds routine work back for a digest instead of interleaving half-sentences", () => {
    const r = twoAgents();
    expect(r.classify(ev({ paneId: "canvas:projA:a1", ts: NOW + 20 }), NOW + 20).action).toBe("defer_to_digest");
  });

  it("lets a failure cut straight through, named", () => {
    // The whole point of the pierce list: a regression in a background agent must reach the user
    // even while everything else is being batched.
    const decision = twoAgents().classify(
      ev({ paneId: "canvas:projB:b1", kind: "tool_post", tag: "tool_post_failure", ts: NOW + 20 }),
      NOW + 20,
    );

    expect(decision.action).toBe("speak");
    expect(decision.labelPrefix).toBe("b1: ");
  });

  it("lets a new user prompt through immediately rather than batching it", () => {
    // Batching "you just asked X" into a flush two seconds later is useless — by then the agent
    // has already started answering.
    expect(
      twoAgents().classify(ev({ paneId: "canvas:projA:a1", kind: "prompt_intent", tag: "prompt_intent", ts: NOW + 20 }), NOW + 20)
        .action,
    ).toBe("speak");
  });
});

describe("narration router — following one agent", () => {
  it("drops everything but the pinned agent", () => {
    const r = router();
    r.pin("canvas:projA:a1");

    expect(r.classify(ev({ paneId: "canvas:projA:a1" }), NOW).action).toBe("speak");
    expect(r.classify(ev({ paneId: "canvas:projB:b1" }), NOW).action).toBe("drop");
  });

  it("still lets a failure from an unpinned agent through", () => {
    // Pinning is "narrate this one to me", not "hide everything else breaking".
    const r = router();
    r.pin("canvas:projA:a1");

    expect(
      r.classify(ev({ paneId: "canvas:projB:b1", kind: "tool_post", tag: "tool_post_failure" }), NOW).action,
    ).toBe("speak");
  });

  it("goes back to speaking everything once unpinned", () => {
    const r = router();
    r.pin("canvas:projA:a1");
    r.unpin();

    expect(r.classify(ev({ paneId: "canvas:projB:b1" }), NOW).action).toBe("speak");
  });
});

describe("narration router — the per-project channel", () => {
  /**
   * Two agents in DIFFERENT projects, so the router is in multi-agent mode.
   *
   * The second seed event is itself deferred (by then two agents are active), so the residue is
   * drained here — otherwise every assertion below would also see projB's seed and the tests would
   * be measuring the fixture rather than the behaviour.
   */
  const busyRouter = () => {
    const r = router();
    r.classify(ev({ paneId: "canvas:projA:a1" }), NOW);
    r.classify(ev({ paneId: "canvas:projB:b1", ts: NOW + 1 }), NOW + 1);
    r.collectFlushes(NOW + 1 + CHANNEL_MAX_PENDING * CHANNEL_IDLE_FLUSH_MS);
    return r;
  };

  it("holds a deferred burst back while the project is still working", () => {
    const r = busyRouter();
    r.classify(ev({ paneId: "canvas:projA:a1", ts: NOW + 10 }), NOW + 10);

    // Draining mid-burst would cut the agent off mid-thought; wait for a natural turn boundary.
    expect(r.collectFlushes(NOW + 500)).toEqual([]);
  });

  it("drains a project once it falls quiet", () => {
    const r = busyRouter();
    r.classify(ev({ paneId: "canvas:projA:a1", tag: "tool_edit", ts: NOW + 10 }), NOW + 10);

    const flushes = r.collectFlushes(NOW + 10 + CHANNEL_IDLE_FLUSH_MS + 1);

    expect(flushes).toHaveLength(1);
    expect(flushes[0].projectId).toBe("projA");
    expect(flushes[0].events).toHaveLength(1);
  });

  it("drains early when a busy agent piles up, rather than holding its update hostage", () => {
    const r = busyRouter();
    for (let i = 0; i < CHANNEL_MAX_PENDING; i += 1) {
      r.classify(ev({ paneId: "canvas:projA:a1", ts: NOW + 10 + i }), NOW + 10 + i);
    }

    // Still "busy" — nowhere near the idle window — but the backlog itself forces a drain.
    const flushes = r.collectFlushes(NOW + 11 + CHANNEL_MAX_PENDING);

    expect(flushes).toHaveLength(1);
    expect(flushes[0].events).toHaveLength(CHANNEL_MAX_PENDING);
  });

  it("collapses two agents in one project into a single update", () => {
    // Otherwise the listener gets two indistinguishable "Lotus: …" blurbs back to back.
    const r = router();
    r.classify(ev({ paneId: "canvas:projA:a1" }), NOW);
    r.classify(ev({ paneId: "canvas:projA:a2", ts: NOW + 1 }), NOW + 1);
    r.classify(ev({ paneId: "canvas:projB:b1", ts: NOW + 2 }), NOW + 2);
    r.classify(ev({ paneId: "canvas:projA:a1", ts: NOW + 3 }), NOW + 3);
    r.classify(ev({ paneId: "canvas:projA:a2", ts: NOW + 4 }), NOW + 4);

    const flushes = r.collectFlushes(NOW + 5 + CHANNEL_IDLE_FLUSH_MS);
    const projA = flushes.find((f) => f.projectId === "projA");

    expect(projA?.paneIds.sort()).toEqual(["canvas:projA:a1", "canvas:projA:a2"]);
  });

  it("clears what it drained, so the next flush starts empty", () => {
    const r = busyRouter();
    r.classify(ev({ paneId: "canvas:projA:a1", ts: NOW + 10 }), NOW + 10);
    const late = NOW + 10 + CHANNEL_IDLE_FLUSH_MS + 1;

    expect(r.collectFlushes(late)).toHaveLength(1);
    expect(r.collectFlushes(late + 1)).toEqual([]);
  });

  it("never batches a pierce — it was already spoken", () => {
    const r = busyRouter();
    r.classify(ev({ paneId: "canvas:projA:a1", kind: "tool_post", tag: "tool_post_failure", ts: NOW + 10 }), NOW + 10);

    expect(r.collectFlushes(NOW + 10 + CHANNEL_IDLE_FLUSH_MS + 1)).toEqual([]);
  });
});
