import { beforeEach, describe, expect, it } from "vitest";
import {
  getActiveProjectLocation,
  setActiveProjectLocation,
} from "../canvas-active-project";

describe("the active project's machine", () => {
  beforeEach(() => setActiveProjectLocation(null));

  it("is absent for a project on this machine", () => {
    setActiveProjectLocation({ kind: "local" });
    expect(getActiveProjectLocation()).toBeNull();
  });

  it("is absent when no project is open", () => {
    setActiveProjectLocation(undefined);
    expect(getActiveProjectLocation()).toBeNull();
  });

  it("turns the row's nulls into absent keys, so it can be handed straight to the PTY seam", () => {
    setActiveProjectLocation({ kind: "ssh", host: "devbox-vps", user: null, port: null, label: null });
    expect(getActiveProjectLocation()).toEqual({ kind: "ssh", host: "devbox-vps" });
  });

  it("keeps a user, port and label when the row has them", () => {
    setActiveProjectLocation({ kind: "ssh", host: " devbox-vps ", user: "root", port: 2222, label: "VPS" });
    expect(getActiveProjectLocation()).toEqual({
      kind: "ssh",
      host: "devbox-vps",
      user: "root",
      port: 2222,
      label: "VPS",
    });
  });

  it("refuses a machine with no host rather than building a broken ssh target", () => {
    setActiveProjectLocation({ kind: "ssh", host: "   " });
    expect(getActiveProjectLocation()).toBeNull();
  });
});
