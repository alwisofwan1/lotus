import { beforeEach, describe, expect, it } from "vitest";
import {
  LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY,
  loadLastActiveShellDestination,
  persistLastActiveShellDestination,
  resolveShellDestinationFromPath,
} from "./last-shell-destination";

describe("last-shell-destination", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("resolves shell destinations from nested module routes", () => {
    expect(resolveShellDestinationFromPath("/canvas/board-1")).toBe("/canvas");
    // `/codechat` was retired in 07o, the same way.
    expect(resolveShellDestinationFromPath("/codechat/thread-1")).toBe("/");
    expect(resolveShellDestinationFromPath("/canvas")).toBe("/canvas");
    // `/terminal` was retired with CodeSpace: it is no longer a destination, so it resolves to
    // the workspace rather than sending someone back to a route that does not exist.
    expect(resolveShellDestinationFromPath("/terminal")).toBe("/");
  });

  it("persists the current module when the pathname is outside settings", () => {
    persistLastActiveShellDestination("/canvas/board-a");

    expect(window.localStorage.getItem(LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY)).toBe("/canvas");
  });

  it("keeps the stored module unchanged while inside settings", () => {
    window.localStorage.setItem(LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY, "/canvas");

    persistLastActiveShellDestination("/settings?section=codechat");

    expect(window.localStorage.getItem(LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY)).toBe("/canvas");
  });

  it("loads a safe fallback when the stored destination is missing or invalid", () => {
    expect(loadLastActiveShellDestination()).toBe("/");

    window.localStorage.setItem(LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY, "/settings");

    expect(loadLastActiveShellDestination()).toBe("/");
  });
});
