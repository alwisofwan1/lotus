import { describe, expect, it } from "vitest";
import { machineGroups, machineLabel, type MachineUsage, type UsageAccount } from "../usage";

const row = (account: string, extra: Partial<UsageAccount> = {}): UsageAccount => ({
  provider: "claude",
  account,
  plan: "max",
  inUse: false,
  windows: [],
  error: null,
  ...extra,
});
const me = { email: "me@x.io", org: "Acme" };
const vps = (accounts: UsageAccount[], extra: Partial<MachineUsage> = {}): MachineUsage => ({
  target: "devbox-vps",
  machine: "vmi123",
  state: "live",
  accounts,
  error: null,
  asOfMs: null,
  ...extra,
});

describe("machineGroups", () => {
  it("is one group with no heading when no other machine answers", () => {
    const groups = machineGroups([row("default")], []);
    expect(groups.map((g) => g.label)).toEqual(["This Mac"]);
    expect(groups[0].accounts[0].target).toBeNull();
  });

  it("shows an account signed in on two machines once, with the fresher numbers", () => {
    const local = row("default", { identity: me, error: "idle — not used in the last 8 h", asOfMs: 5 });
    const remote = row("main", { identity: me });
    const groups = machineGroups([local, row("work")], [vps([remote])]);
    expect(groups[0].accounts.map((a) => a.account)).toEqual(["work"]);
    expect(groups[1].accounts.map((a) => a.account)).toEqual(["main"]);
    expect(groups[1].accounts[0].signedInOn).toEqual(["This Mac", "devbox-vps"]);
  });

  it("keeps the local copy when both are fresh, and does not merge rows without an identity", () => {
    const groups = machineGroups([row("default", { identity: me }), row("a")], [vps([row("main", { identity: me }), row("a")])]);
    expect(groups[0].accounts.map((a) => a.account)).toEqual(["default", "a"]);
    expect(groups[1].accounts.map((a) => a.account)).toEqual(["a"]);
  });

  it("treats a machine that is not connected as older than a live one", () => {
    const groups = machineGroups(
      [row("default", { identity: me, error: "network: offline" })],
      [vps([row("main", { identity: me })], { state: "not-connected", asOfMs: 3 })],
    );
    expect(groups[0].accounts).toEqual([]);
    expect(groups[1].accounts[0].account).toBe("main");
  });

  it("keeps a machine's state and error for its heading, even with no rows left", () => {
    const groups = machineGroups([], [vps([], { state: "old-host", error: "update Lotus Host on vmi123 to see its usage" })]);
    expect(groups[1]).toMatchObject({ label: "devbox-vps", state: "old-host", error: "update Lotus Host on vmi123 to see its usage" });
  });

  it("never merges two accounts on the same machine", () => {
    const groups = machineGroups([row("a", { identity: me }), row("b", { identity: me })], []);
    expect(groups[0].accounts.map((a) => a.account)).toEqual(["a", "b"]);
    expect(groups[0].accounts[0].signedInOn).toBeUndefined();
  });

  it("labels a machine by host, keeping a port only when it is not 22", () => {
    expect(machineLabel("alwi@devbox-vps:22")).toBe("devbox-vps");
    expect(machineLabel("devbox-vps")).toBe("devbox-vps");
    expect(machineLabel("root@10.0.0.5:2222")).toBe("10.0.0.5:2222");
  });
});
