import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { fleetSections, FLEET_SECTION_TITLE, STATUS_PHRASE } from "../canvas-fleet-sections";
import type { AgentStatusSnapshot } from "../agent-status-registry";

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as unknown as Node;

const agent = (id: string, name: string) => node(id, "agent", { name, model: "claude-sonnet" });

const live = (id: string, status: AgentStatusSnapshot["status"]): AgentStatusSnapshot =>
  ({ id, name: id, status });

const sectionsOf = (nodes: Node[], statuses: AgentStatusSnapshot[] = [], headlines: Record<string, string> = {}) =>
  fleetSections(nodes, statuses, (id) => headlines[id]);

describe("fleetSections", () => {
  it("puts an agent under AGENTS", () => {
    const [section] = sectionsOf([agent("a1", "Atlas")]);

    expect(section.id).toBe("agents");
    expect(section.rows[0]).toMatchObject({ id: "a1", label: "Atlas" });
  });

  it("keeps the agent family together", () => {
    // team/critic/human-gate are part of the agent flow, not scenery. Splitting them into CARDS
    // would bury a blocking human-gate among sticky notes.
    const rows = sectionsOf([
      agent("a1", "Atlas"),
      node("t1", "team"),
      node("c1", "critic"),
      node("h1", "human-gate"),
    ])[0].rows;

    expect(rows.map((r) => r.id)).toEqual(["a1", "t1", "c1", "h1"]);
  });

  it("puts terminals and browsers under WINDOWS", () => {
    const sections = sectionsOf([node("t1", "terminal", { cwd: "/repo" }), node("b1", "browser")]);

    const windows = sections.find((s) => s.id === "windows");
    expect(windows?.rows.map((r) => r.id)).toEqual(["t1", "b1"]);
  });

  it("puts the rest under CARDS", () => {
    const sections = sectionsOf([node("n1", "note"), node("p1", "plan"), node("k1", "task")]);

    const cards = sections.find((s) => s.id === "cards");
    expect(cards?.rows.map((r) => r.id)).toEqual(["n1", "p1", "k1"]);
  });

  it("orders sections agents, windows, cards", () => {
    const sections = sectionsOf([node("n1", "note"), node("t1", "terminal"), agent("a1", "Atlas")]);

    expect(sections.map((s) => s.id)).toEqual(["agents", "windows", "cards"]);
  });

  it("omits a section with nothing in it, rather than printing an empty heading", () => {
    expect(sectionsOf([agent("a1", "Atlas")]).map((s) => s.id)).toEqual(["agents"]);
  });

  it("keeps canvas order inside a section", () => {
    const rows = sectionsOf([agent("a2", "Bima"), agent("a1", "Atlas")])[0].rows;

    expect(rows.map((r) => r.label)).toEqual(["Bima", "Atlas"]);
  });

  it("leaves out an agent that is already in the needs-you lane", () => {
    // The whole point of the rewrite is one row per cell. A blocked agent pinned at the top and
    // repeated below is the duplication this panel exists to remove.
    const sections = sectionsOf([agent("a1", "Atlas"), agent("a2", "Bima")], [live("a1", "needs-you")]);

    expect(sections[0].rows.map((r) => r.id)).toEqual(["a2"]);
  });

  it("drops a section that emptied out because every agent needs a human", () => {
    expect(sectionsOf([agent("a1", "Atlas")], [live("a1", "needs-you")])).toEqual([]);
  });

  it("carries the live status so a row can show the right dot", () => {
    const rows = sectionsOf([agent("a1", "Atlas")], [live("a1", "running")])[0].rows;

    expect(rows[0].status).toBe("running");
  });

  it("prefers the headline over the descriptor's detail", () => {
    // The detail for an agent is its model — true, and the same for every agent on the board. The
    // headline says what THIS one was asked to do.
    const rows = sectionsOf([agent("a1", "Atlas")], [], { a1: "perbaiki judul agent" })[0].rows;

    expect(rows[0].detail).toBe("perbaiki judul agent");
  });

  it("falls back to the descriptor when no headline exists yet", () => {
    const rows = sectionsOf([agent("a1", "Atlas")])[0].rows;

    expect(rows[0].detail).toBe("claude-sonnet");
  });

  it("does not let a headline override a terminal's compact location", () => {
    // Headlines belong to agents. A terminal's compact cwd context must remain stable, and the
    // headline store is keyed by pane id, so a collision there must not rewrite this row.
    const rows = sectionsOf([node("t1", "terminal", { cwd: "/repo/apps/desktop" })], [], {
      t1: "something else entirely",
    }).find((s) => s.id === "windows")!.rows;

    expect(rows[0].detail).toBe("desktop");
  });

  it("ignores a node type the navigator does not know", () => {
    // Unknown types come from newer boards and future node kinds. Filing them under CARDS would put
    // an unlabelled row in front of the operator; omitting them is the honest answer.
    expect(sectionsOf([node("x1", "quantum-widget")])).toEqual([]);
  });

  it("names its sections", () => {
    expect(FLEET_SECTION_TITLE.agents).toBe("Agents");
    expect(FLEET_SECTION_TITLE.windows).toBe("Windows");
    expect(FLEET_SECTION_TITLE.cards).toBe("Cards");
  });

  describe("the second line answers \"what is this one doing\"", () => {
    // The rows shipped blank underneath the name. Two reasons, and the interesting one is second.
    //
    // 1. `describeCanvasNode` falls back to `"agent"` only when `model` is not a string — and an
    //    empty string IS a string. Bare launches are the norm (ADR-0027: "a launched runner is just
    //    the CLI, no baked role/model"), so `detail` was "".
    // 2. The model was never the right answer anyway: it is identical across agents and already
    //    implied by the runner glyph. What the operator wants is what the agent is DOING.
    //
    // Layered no longer. The state used to compete for this slot and win or lose depending on
    // whether a headline had arrived — so an agent that had been given a task reported no status,
    // and one that had not said nothing about itself. Three facts, one slot, two discarded on every
    // render. `state` is its own field now, and PRODUCT.md's requirement that status not be carried
    // by dot colour alone is settled there instead.

    it("prefers the ask over anything else", () => {
      const rows = sectionsOf([agent("a1", "Atlas")], [live("a1", "running")], {
        a1: "perbaiki judul agent",
      })[0].rows;

      expect(rows[0].detail).toBe("perbaiki judul agent");
    });

    it("reports its state whether or not it has been asked anything", () => {
      const asked = sectionsOf([agent("a1", "Atlas")], [live("a1", "running")], {
        a1: "perbaiki judul agent",
      })[0].rows;
      const unasked = sectionsOf([agent("a1", "Atlas")], [live("a1", "running")])[0].rows;

      // The regression this pins: the row used to drop one of these depending on the other.
      expect(asked[0].state).toBe(STATUS_PHRASE.running);
      expect(asked[0].detail).toBe("perbaiki judul agent");
      expect(unasked[0].state).toBe(STATUS_PHRASE.running);
    });

    it("covers every state, so a row is never blank while the dot is lit", () => {
      const states = ["idle", "connecting", "running", "completed", "error", "stalled"] as const;

      for (const status of states) {
        const rows = sectionsOf([agent("a1", "Atlas")], [live("a1", status)])[0].rows;
        expect(rows[0].state, status).toBe(STATUS_PHRASE[status]);
      }
    });

    it("ignores an empty model instead of printing nothing", () => {
      // The exact shape a bare launch produces.
      const bare = node("a1", "agent", { name: "Atlas", model: "" });

      const rows = sectionsOf([bare], [live("a1", "idle")])[0].rows;

      // Nothing to say about itself, so the context line is empty — and the state line carries it.
      expect(rows[0].detail).toBe("");
      expect(rows[0].state).toBe(STATUS_PHRASE.idle);
    });

    it("leaves a terminal its compact cwd context, not a fabricated mood", () => {
      const rows = sectionsOf([node("t1", "terminal", { cwd: "/repo/apps/desktop" })], [
        live("t1", "running"),
      ]).find((s) => s.id === "windows")!.rows;

      expect(rows[0].detail).toBe("desktop");
    });

    it("says nothing at all for a cell with neither an ask nor a state", () => {
      // A note has no state and no ask. Inventing a phrase would be louder than the truth.
      const rows = sectionsOf([node("n1", "note")]).find((s) => s.id === "cards")!.rows;

      expect(rows[0].detail).toBe("");
      // Absent, not empty: a note is not idle, it simply has no state to be in.
      expect(rows[0].state).toBeUndefined();
    });
  });

  describe("time in state", () => {
    const NOW = 1_700_000_000_000;
    const withClock = (statuses: AgentStatusSnapshot[]) =>
      fleetSections([agent("a1", "Atlas")], statuses, () => undefined, NOW);

    it("says how long it has been like this", () => {
      const rows = withClock([
        { id: "a1", name: "Atlas", status: "stalled", statusChangedAt: NOW - 42 * 60_000 },
      ])[0].rows;

      expect(rows[0].state).toBe("quiet · 42m");
    });

    it("stays a bare word when the stamp is missing", () => {
      // A snapshot pushed from elsewhere may not carry one. Printing "· 0s" would claim the state
      // just began, when the truth is that we do not know.
      const rows = withClock([{ id: "a1", name: "Atlas", status: "stalled" }])[0].rows;

      expect(rows[0].state).toBe("quiet");
    });

    it("stays a bare word when the caller passes no clock", () => {
      const rows = fleetSections(
        [agent("a1", "Atlas")],
        [{ id: "a1", name: "Atlas", status: "idle", statusChangedAt: NOW - 60_000 }],
        () => undefined,
      )[0].rows;

      expect(rows[0].state).toBe("ready");
    });

    it("never counts backwards from a stamp in the future", () => {
      // Clock skew on a pushed snapshot. `formatWaiting` floors, so a negative would print oddly.
      const rows = withClock([
        { id: "a1", name: "Atlas", status: "idle", statusChangedAt: NOW + 5_000 },
      ])[0].rows;

      expect(rows[0].state).toBe("ready · 0s");
    });

    it("keeps the duration off the ask — it belongs to a state, not an instruction", () => {
      const rows = fleetSections(
        [agent("a1", "Atlas")],
        [{ id: "a1", name: "Atlas", status: "running", statusChangedAt: NOW - 60_000 }],
        () => "jalankan test",
        NOW,
      )[0].rows;

      expect(rows[0].detail).toBe("jalankan test");
      expect(rows[0].state).toBe("working · 1m");
    });
  });
});

/**
 * The context line's floor (`plans/canvas-fleet-panel/` — three-line row).
 *
 * `describeCanvasNode` gives an agent its model, and a bare launch has none (ADR-0027) — so the
 * line was blank for exactly the rows that fill a freshly spawned board.
 */
describe("the runner's name, when there is nothing else to say", () => {
  const NOW = 1_700_000_000_000;
  const withRunner = (label?: string, headline?: string) =>
    fleetSections(
      [node("a1", "agent", { name: "Atlas", model: "" })],
      [{ id: "a1", name: "Atlas", status: "running", statusChangedAt: NOW, runnerLabel: label }],
      () => headline,
      NOW,
    )[0].rows[0];

  it("names the runner when the agent has no model and no ask", () => {
    expect(withRunner("Codex").detail).toBe("Codex");
    expect(withRunner("Codex").detailKind).toBe("identity");
  });

  // A floor, not a preference: what an agent is DOING beats what it is.
  it("still yields to a live headline", () => {
    const row = withRunner("Codex", "reading agent-node-graph.css");

    expect(row.detail).toBe("reading agent-node-graph.css");
    expect(row.detailKind).toBe("ask");
    // And the state keeps its own line either way.
    expect(row.state).toBe("working · 0s");
  });

  it("stays empty rather than inventing one when the runner is unknown", () => {
    expect(withRunner(undefined).detail).toBe("");
  });

  // A terminal's identity is its cwd. A runner name has no business displacing it.
  it("leaves non-agent cells alone", () => {
    const rows = fleetSections(
      [node("t1", "terminal", { cwd: "/repo" })],
      [{ id: "t1", name: "t1", status: "running", runnerLabel: "Codex" }],
      () => undefined,
    ).find((s) => s.id === "windows")!.rows;

    expect(rows[0].detail).toBe("repo");
  });
});

/**
 * The headline lookup's key.
 *
 * `agentHeadlineStore` is written by `useAgentHeadlineFeed` under the PANE id, and
 * `canvasRuntimePaneId` makes that `canvas:<projectId>:<nodeId>` whenever a project is open —
 * which is always, on a real board. This list looked headlines up by NODE id, so it could never
 * match, and the failure was silent: a missed key returns `undefined`, which reads exactly like an
 * agent nobody has asked anything. The needs-you lane keys on the pane id and has always worked.
 */
describe("headlines are keyed by pane id", () => {
  const PANE = "canvas:cp_1:a1";

  it("asks the store for the pane id the snapshot publishes", () => {
    const seen: string[] = [];
    fleetSections(
      [node("a1", "agent", { name: "Atlas", model: "" })],
      [{ id: "a1", name: "Atlas", status: "running", hookPaneId: PANE }],
      (key) => {
        seen.push(key);
        return key === PANE ? "reading agent-node-graph.css" : undefined;
      },
    );

    expect(seen).toContain(PANE);
  });

  it("shows the headline that only the pane id can reach", () => {
    const row = fleetSections(
      [node("a1", "agent", { name: "Atlas", model: "" })],
      [{ id: "a1", name: "Atlas", status: "running", hookPaneId: PANE }],
      (key) => (key === PANE ? "reading agent-node-graph.css" : undefined),
    )[0].rows[0];

    expect(row.detail).toBe("reading agent-node-graph.css");
    expect(row.detailKind).toBe("ask");
  });

  // A cell with no live entry has nothing but its node id, and that is the right key for it.
  it("falls back to the node id when no snapshot carries a pane id", () => {
    const seen: string[] = [];
    fleetSections([node("a1", "agent", { name: "Atlas" })], [], (key) => {
      seen.push(key);
      return undefined;
    });

    expect(seen).toContain("a1");
  });
});
