import { describe, expect, it } from "vitest";
import { machineFromLocation, machineKey, sshTarget, wireTarget } from "../machine";

describe("a project's machine", () => {
  it("is absent for a project on this machine, or with no location at all", () => {
    expect(machineFromLocation({ kind: "local" })).toBeNull();
    expect(machineFromLocation(null)).toBeNull();
    expect(machineFromLocation(undefined)).toBeNull();
  });

  it("refuses a machine with no host rather than building a broken ssh target", () => {
    expect(machineFromLocation({ kind: "ssh", host: "   " })).toBeNull();
  });

  it("turns the row's nulls into absent keys and trims the host", () => {
    expect(machineFromLocation({ kind: "ssh", host: " devbox-vps ", user: null, port: null, label: null })).toEqual({
      kind: "ssh",
      host: "devbox-vps",
    });
    expect(machineFromLocation({ kind: "ssh", host: "h", user: "root", port: 2222, label: "VPS" })).toEqual({
      kind: "ssh",
      host: "h",
      user: "root",
      port: 2222,
      label: "VPS",
    });
  });
});

describe("a machine's key", () => {
  it("is the identity the Rust store keys a project by", () => {
    expect(machineKey({ host: "DEVBOX-VPS", user: "Root", port: 22 })).toBe("ssh:root@devbox-vps:22");
    expect(machineKey({ host: "h" })).toBe("ssh:h");
  });

  it("ignores the label, so renaming a machine is not reconnecting to it", () => {
    expect(machineKey({ kind: "ssh", host: "h", label: "old" })).toBe(machineKey({ kind: "ssh", host: "h", label: "new" }));
  });

  it("is empty for this machine, so it can stand in for an effect dependency", () => {
    expect(machineKey(null)).toBe("");
  });
});

describe("a machine's ssh target", () => {
  it("drops the label and spells absent as a missing key", () => {
    expect(sshTarget({ kind: "ssh", host: "h", label: "VPS" })).toEqual({ host: "h" });
    expect(sshTarget({ kind: "ssh", host: "h", user: "root", port: 2222 })).toEqual({
      host: "h",
      user: "root",
      port: 2222,
    });
  });

  it("spells absent as null on the wire, because serde round-trips it", () => {
    expect(wireTarget({ kind: "ssh", host: "h" })).toEqual({ host: "h", user: null, port: null });
    expect(wireTarget({ kind: "ssh", host: "h", user: "root", port: 2222, label: "VPS" })).toEqual({
      host: "h",
      user: "root",
      port: 2222,
    });
  });
});
