import { describe, expect, it } from "vitest";
import { noteAgentAsk, publishHeadline } from "../agent-ask";
import { createAgentStateRegistry } from "../narration/agent-state-registry";
import { createAgentHeadlineStore } from "../agent-headline-store";

const NOW = 1_700_000_000_000;

const wired = () => {
  const registry = createAgentStateRegistry();
  const headlines = createAgentHeadlineStore();
  return { registry, headlines, deps: { registry, headlines, now: () => NOW } };
};

describe("noteAgentAsk", () => {
  // The path that gives a headline to every runner, not only the Claude family. Codex reports turn
  // ends only and cursor/custom report nothing at all, so waiting for a `prompt-submit` drop would
  // leave most of a mixed board permanently untitled. Lotus sees the ask itself, at the one write
  // choke point in `LiveAgentNode`.

  it("titles the pane with the ask", () => {
    const { headlines, deps } = wired();

    noteAgentAsk("canvas:cp_1:a1", "perbaiki judul agent", deps);

    expect(headlines.get("canvas:cp_1:a1")).toBe("perbaiki judul agent");
  });

  it("opens the turn, because submitting an ask is how one starts", () => {
    const { registry, deps } = wired();

    noteAgentAsk("canvas:cp_1:a1", "run the tests", deps);

    expect(registry.get("canvas:cp_1:a1")?.turnActive).toBe(true);
  });

  it("replaces the headline on the next ask", () => {
    const { headlines, deps } = wired();
    noteAgentAsk("canvas:cp_1:a1", "run the tests", deps);

    noteAgentAsk("canvas:cp_1:a1", "now fix the lint", deps);

    expect(headlines.get("canvas:cp_1:a1")).toBe("now fix the lint");
  });

  it("keeps panes apart", () => {
    const { headlines, deps } = wired();

    noteAgentAsk("canvas:cp_1:a1", "run the tests", deps);
    noteAgentAsk("canvas:cp_1:a2", "review the diff", deps);

    expect(headlines.get("canvas:cp_1:a1")).toBe("run the tests");
    expect(headlines.get("canvas:cp_1:a2")).toBe("review the diff");
  });

  it("does not disturb the narration salience clock", () => {
    // `lastEventAt` and `errorCount` are what `salienceOf` ranks the voice narrator's attention by,
    // and they are fed by hook drops. An operator's keystroke is not one of those: letting it move
    // the clock would make a pane sound freshly active on a channel narration never observed.
    const { registry, deps } = wired();

    noteAgentAsk("canvas:cp_1:a1", "run the tests", deps);

    expect(registry.get("canvas:cp_1:a1")?.eventCount).toBe(0);
  });

  it("survives a pane that has never been seen before", () => {
    const { registry, deps } = wired();

    noteAgentAsk("canvas:cp_1:new", "halo", deps);

    expect(registry.get("canvas:cp_1:new")?.lastPrompt).toBe("halo");
  });
});

describe("publishHeadline", () => {
  it("is the single place a composed headline reaches the store", () => {
    // Extracted rather than written twice. The 2026-08-26 defect lived exactly here — in the pair of
    // "compose" and "record" — and two copies of that pair is two places for it to come back.
    const { registry, headlines, deps } = wired();
    const state = registry.observe({
      kind: "tool_pre",
      tag: "tool_edit",
      neutral: "",
      paneId: "canvas:cp_1:a1",
      ts: NOW,
    });

    publishHeadline("canvas:cp_1:a1", state, deps);

    expect(headlines.get("canvas:cp_1:a1")).toBe("editing");
  });
});
