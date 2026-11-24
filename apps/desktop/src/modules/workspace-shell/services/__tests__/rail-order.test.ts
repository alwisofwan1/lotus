import { describe, expect, it } from "vitest";
import { orderRailWorkspaces, railSections, togglePinned, toggleOpen, withOpen } from "../rail-order";
import type { RailWorkspace } from "@/modules/workspace-shell/types";

const ws = (id: string): RailWorkspace => ({ id, name: id, panes: [] });

describe("orderRailWorkspaces", () => {
  it("lifts pinned folders to the top and marks them", () => {
    const ordered = orderRailWorkspaces([ws("a"), ws("b"), ws("c")], ["c"]);
    expect(ordered.map((workspace) => workspace.id)).toEqual(["c", "a", "b"]);
    expect(ordered[0].pinned).toBe(true);
    expect(ordered[1].pinned).toBeFalsy();
  });

  it("keeps the engine's order within each group, so nothing jumps while typing", () => {
    const ordered = orderRailWorkspaces([ws("a"), ws("b"), ws("c"), ws("d")], ["d", "b"]);
    expect(ordered.map((workspace) => workspace.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("drops a pin whose workspace was renamed away from it", () => {
    const ordered = orderRailWorkspaces([{ ...ws("a"), pinned: true }], []);
    expect(ordered[0].pinned).toBe(false);
  });
});

describe("the rail's stored id sets", () => {
  it("pins and unpins", () => {
    expect(togglePinned([], "a")).toEqual(["a"]);
    expect(togglePinned(["a", "b"], "a")).toEqual(["b"]);
  });

  it("opening one folder never closes another — the point of the change", () => {
    expect(toggleOpen(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleOpen(["a", "b"], "a")).toEqual(["b"]);
  });

  it("forces a folder open without duplicating it", () => {
    expect(withOpen(["a"], "b")).toEqual(["a", "b"]);
    expect(withOpen(["a", "b"], "b")).toEqual(["a", "b"]);
  });
});

describe("railSections", () => {
  it("stays a flat list while nothing is pinned", () => {
    const sections = railSections(orderRailWorkspaces([ws("a"), ws("b")], []));
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("");
  });

  it("labels the two groups once something is pinned", () => {
    const sections = railSections(orderRailWorkspaces([ws("a"), ws("b")], ["b"]));
    expect(sections.map((section) => section.label)).toEqual(["Pinned", "Workspaces"]);
    expect(sections[0].workspaces.map((workspace) => workspace.id)).toEqual(["b"]);
    expect(sections[1].workspaces.map((workspace) => workspace.id)).toEqual(["a"]);
  });

  it("drops the empty group when everything is pinned", () => {
    const sections = railSections(orderRailWorkspaces([ws("a")], ["a"]));
    expect(sections.map((section) => section.label)).toEqual(["Pinned"]);
  });
});
