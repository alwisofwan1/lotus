import { describe, expect, it } from "vitest";
import { createPaneTurnRegistry } from "@/modules/codecanvas/services/pane-turn-registry";
import { createPaneTurnEnds } from "@/modules/workspace-shell/services/pane-turn-ends";

/**
 * When a pane's turn is over, as CodeCanvas decides it: the Stop hook is authoritative, a PTY settle
 * is the backstop, and one turn is reported once whichever arrives first.
 */
function setup() {
  return createPaneTurnEnds({ turns: createPaneTurnRegistry(() => 1_000) });
}

describe("pane turn ends", () => {
  it("says whether a submit opened the turn, so an alert can tell asked-for work from churn", () => {
    const turnEnds = setup();
    expect(turnEnds.isTurnOpen("p1")).toBe(false);
    turnEnds.noteInput("p1", "go\r");
    expect(turnEnds.isTurnOpen("p1")).toBe(true);
  });

  it("reports a Stop hook after a submitted prompt", () => {
    const turnEnds = setup();
    turnEnds.noteInput("p1", "fix the drag bug\r");

    expect(turnEnds.hookStopped("p1")).toBe(true);
  });

  it("reports one turn once, even when the settle arrives after the hook", () => {
    const turnEnds = setup();
    turnEnds.noteInput("p1", "go\r");

    expect(turnEnds.hookStopped("p1")).toBe(true);
    expect(turnEnds.settled("p1")).toBe(false);
  });

  it("does not count a settle that no submit opened — a repaint is not work", () => {
    const turnEnds = setup();
    turnEnds.noteInput("p1", "typing without enter");
    turnEnds.noteOutput("p1");

    expect(turnEnds.settled("p1")).toBe(false);
  });

  it("uses the settle for a runner that has no Stop hook", () => {
    const turnEnds = setup();
    turnEnds.noteInput("p1", "go\r");

    expect(turnEnds.settled("p1")).toBe(true);
  });

  it("stops trusting settles on a pane once its hook has spoken", () => {
    const turnEnds = setup();
    turnEnds.noteInput("p1", "first\r");
    turnEnds.hookStopped("p1");
    turnEnds.noteInput("p1", "second\r");

    expect(turnEnds.settled("p1")).toBe(false);
    expect(turnEnds.hookStopped("p1")).toBe(true);
  });

  it("reports every new turn, not only the first", () => {
    const turnEnds = setup();
    turnEnds.noteInput("p1", "first\r");
    turnEnds.settled("p1");
    turnEnds.noteInput("p1", "second\r");

    expect(turnEnds.settled("p1")).toBe(true);
  });

  it("starts a forgotten pane from nothing", () => {
    const turnEnds = setup();
    turnEnds.noteInput("p1", "go\r");
    turnEnds.hookStopped("p1");
    turnEnds.forget("p1");
    turnEnds.noteInput("p1", "go\r");

    expect(turnEnds.settled("p1")).toBe(true);
  });

  /**
   * Seen live 2026-09-24: two Claude panes lit up "done" from a PTY settle ~30s after a hot reload,
   * although their hook was alive (`fact=idle`). Hook coverage lived in this instance's memory, and
   * a remount forgot it. Whether the hook has ever reported for a pane is a durable fact elsewhere.
   */
  it("does not fall back on a pane whose hook reported before this instance existed", () => {
    const turnEnds = createPaneTurnEnds({
      turns: createPaneTurnRegistry(() => 1_000),
      hookHasReported: (paneId) => paneId === "p1",
    });
    turnEnds.noteInput("p1", "go\r");

    expect(turnEnds.settled("p1")).toBe(false);
  });
});
