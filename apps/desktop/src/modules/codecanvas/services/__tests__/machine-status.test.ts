import { describe, expect, it } from "vitest";
import { machineStatusView, type MachineStatusInput } from "../machine-status";

const base: MachineStatusInput = { label: "devbox-vps", tunnel: { state: "open", ports: [9877] }, hooks: { state: "ready" } };

describe("the machine status a remote board shows", () => {
  it("is green only when the way home is open and the hook is in place", () => {
    const view = machineStatusView(base);
    expect(view.tone).toBe("ok");
    expect(view.chip).toBe("devbox-vps");
    expect(view.connection.title).toBe("Terhubung");
    expect(view.wayHome.title).toBe("Terbuka");
    expect(view.primary).toBeNull();
    expect(view.title).toMatch(/bisa melapor balik/);
  });

  /// A machine whose hook was never asked about reads as fine, not as broken.
  it("treats a hook never asked about as no worse than one that answered", () => {
    expect(machineStatusView({ ...base, hooks: null }).tone).toBe("ok");
  });

  it("holds short of green while it is still connecting", () => {
    const view = machineStatusView({ ...base, tunnel: null, hooks: null });
    expect(view.tone).toBe("warn");
    expect(view.chip).toBe("devbox-vps · menyiapkan…");
    expect(view.connection.title).toBe("Menyambung…");
  });

  it("holds short of green while the hook is still being installed", () => {
    const view = machineStatusView({ ...base, hooks: { state: "pending" } });
    expect(view.tone).toBe("warn");
    expect(view.chip).toBe("devbox-vps · menyiapkan…");
  });

  /// Screen 10 is a contract: a dead tunnel stops the agent reporting, not the terminal.
  it("says the agent went quiet, not that the machine is gone, and offers a retry", () => {
    const view = machineStatusView({
      ...base,
      tunnel: { state: "failed", ports: [], detail: "remote port forwarding failed for listen port 9877" },
    });
    expect(view.tone).toBe("warn");
    expect(view.chip).toBe("devbox-vps · tak melapor");
    expect(view.connection.title).toBe("Terhubung");
    expect(view.wayHome.title).toBe("Terputus");
    expect(view.wayHome.detail).toMatch(/9877/);
    expect(view.primary).toBe("retry");
    expect(view.title).toMatch(/terminal tetap jalan/);
  });

  it("does not turn green on a tunnel whose hook could not be installed", () => {
    const view = machineStatusView({ ...base, hooks: { state: "failed", detail: "settings.json is not valid JSON" } });
    expect(view.tone).toBe("warn");
    expect(view.chip).toBe("devbox-vps · tak melapor");
    expect(view.wayHome.detail).toMatch(/settings\.json/);
    expect(view.primary).toBe("retry");
    expect(view.title).toMatch(/hook gagal dipasang/);
  });

  /// When ssh itself cannot get in, nothing on the machine works — that is red, with a reason.
  it("is red when ssh itself cannot reach the machine, with one sentence and one action", () => {
    const view = machineStatusView({
      ...base,
      tunnel: { state: "failed", ports: [], detail: "root@devbox-vps: Permission denied (publickey)." },
    });
    expect(view.tone).toBe("bad");
    expect(view.chip).toBe("devbox-vps · gagal");
    expect(view.connection.title).toBe("Gagal");
    expect(view.wayHome.title).toBe("Menunggu sambungan");
    expect(view.failure?.title).toBe("devbox-vps rejected the key we have");
    expect(view.primary).toBe("retry");
  });

  it("says plainly that the operator disconnected it, and offers to reconnect", () => {
    const view = machineStatusView({ ...base, disconnected: true });
    expect(view.tone).toBe("off");
    expect(view.chip).toBe("devbox-vps · terputus");
    expect(view.connection.title).toBe("Diputus");
    expect(view.connection.sub).toMatch(/terminal yang sudah jalan tetap hidup/i);
    expect(view.primary).toBe("reconnect");
  });
});
