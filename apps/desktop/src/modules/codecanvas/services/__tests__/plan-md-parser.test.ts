import { describe, it, expect } from "vitest";
import { parsePlanMarkdown, PLAN_MD_FORMAT_INSTRUCTION } from "../plan-md-parser";

describe("parsePlanMarkdown", () => {
  it("extracts checkbox task items with done state", () => {
    const steps = parsePlanMarkdown("- [ ] Build login form\n- [x] Set up CI\nsome prose");
    expect(steps).toEqual([
      { title: "Build login form", done: false },
      { title: "Set up CI", done: true },
    ]);
  });

  it("extracts an owner from @mention or (owner: …)", () => {
    const steps = parsePlanMarkdown("- [ ] Build API @Backend\n- [x] Write docs (owner: Technical Writer)");
    expect(steps[0]).toEqual({ title: "Build API", owner: "Backend", done: false });
    expect(steps[1]).toEqual({ title: "Write docs", owner: "Technical Writer", done: true });
  });

  it("ignores non-task lines and supports * bullets", () => {
    const steps = parsePlanMarkdown("# Plan\n\n* [ ] First\nnot a task\n  - [ ] Indented");
    expect(steps.map((s) => s.title)).toEqual(["First", "Indented"]);
  });

  it("returns empty for content with no task items", () => {
    expect(parsePlanMarkdown("just notes")).toEqual([]);
  });

  // Hardening: the format we instruct agents to produce must actually parse. If the parser
  // or the instruction's example drift apart, this fails.
  it("parses the example embedded in the format instruction we give agents", () => {
    const steps = parsePlanMarkdown(PLAN_MD_FORMAT_INSTRUCTION);
    expect(steps).toEqual([
      { title: "Define the card data model and in-memory store", owner: "Software Architect", done: false },
      { title: "Render the card list from the store", owner: "Frontend Engineer", done: false },
      { title: "Scaffold the project folder", owner: "Backend Engineer", done: true },
    ]);
  });
});
