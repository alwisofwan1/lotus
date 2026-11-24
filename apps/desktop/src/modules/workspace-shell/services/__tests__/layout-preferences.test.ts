import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  parseLayoutPreferences,
  serializeLayoutPreferences,
} from "@/modules/workspace-shell/services/layout-preferences";

describe("parseLayoutPreferences", () => {
  it("returns the default layout when nothing was stored", () => {
    expect(parseLayoutPreferences(null)).toEqual(DEFAULT_LAYOUT);
  });

  it("survives a corrupted value instead of failing to boot", () => {
    expect(parseLayoutPreferences("{not json")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayoutPreferences("42")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayoutPreferences("null")).toEqual(DEFAULT_LAYOUT);
  });

  it("round-trips a layout the user arranged", () => {
    const layout = {
      ...DEFAULT_LAYOUT,
      mode: "chat" as const,
      railVisible: false,
      railWidth: 360,
      openWorkspaceIds: ["lotus", "pocket"],
    };
    expect(parseLayoutPreferences(serializeLayoutPreferences(layout))).toEqual(layout);
  });

  it("starts with Factory closed, and reads an older save that has no Factory flag", () => {
    expect(DEFAULT_LAYOUT.factoryOpen).toBe(false);
    expect(parseLayoutPreferences(JSON.stringify({ tasksOpen: false })).factoryOpen).toBe(false);
  });

  it("keeps the Factory flag, and ignores a value that is not a boolean", () => {
    expect(parseLayoutPreferences(JSON.stringify({ factoryOpen: true })).factoryOpen).toBe(true);
    expect(parseLayoutPreferences(JSON.stringify({ factoryOpen: "yes" })).factoryOpen).toBe(false);
    expect(DEFAULT_LAYOUT.factoryTab).toBe("runs");
    expect(parseLayoutPreferences(JSON.stringify({ factoryTab: "board" })).factoryTab).toBe("board");
    expect(parseLayoutPreferences(JSON.stringify({ factoryTab: "nope" })).factoryTab).toBe("runs");
  });

  it("clamps sizes written by another window size or an older build", () => {
    const parsed = parseLayoutPreferences(
      JSON.stringify({ ...DEFAULT_LAYOUT, railWidth: 5000, terminalWidth: 10, browserHeight: -20 }),
    );
    expect(parsed.railWidth).toBe(520);
    expect(parsed.terminalWidth).toBe(320);
    expect(parsed.browserHeight).toBe(150);
  });

  it("keeps only the recognised mode values", () => {
    expect(parseLayoutPreferences(JSON.stringify({ mode: "canvas" })).mode).toBe("code");
    expect(parseLayoutPreferences(JSON.stringify({ mode: "chat" })).mode).toBe("chat");
  });

  it("drops non-string workspace ids rather than trusting the store", () => {
    const parsed = parseLayoutPreferences(JSON.stringify({ openWorkspaceIds: ["lotus", 7, null] }));
    expect(parsed.openWorkspaceIds).toEqual(["lotus"]);
  });

  it("keeps each view's filters and who Me is, dropping what is not a rule", () => {
    const parsed = parseLayoutPreferences(
      JSON.stringify({
        taskFilters: {
          all: [{ id: "r1", property: "assignee", operator: "contains", values: ["@me"] }],
          broken: [{ property: "nope" }],
        },
        taskMe: { id: "u-1", name: "Alwi Sofwan" },
      }),
    );
    expect(parsed.taskFilters).toEqual({ all: [{ id: "r1", property: "assignee", operator: "contains", values: ["@me"] }] });
    expect(parsed.taskMe).toEqual({ id: "u-1", name: "Alwi Sofwan" });
    expect(parseLayoutPreferences(JSON.stringify({ taskMe: "me" })).taskMe).toBeNull();
  });
});
