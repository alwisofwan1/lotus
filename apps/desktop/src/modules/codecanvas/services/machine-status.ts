import type { TunnelStatus } from "@/lib/tauri-api";
import type { MachineHooks } from "../hooks/useMachineTunnel";
import { describeRemoteFailure, isConnectFailure, type RemoteFailure } from "./remote-failure";

/**
 * What a remote board says about its machine, in the chip and in the popover behind it (board 22).
 *
 * Two rows, because there are two promises: **Sambungan** is whether ssh gets in at all, and **Jalan
 * pulang** is whether an agent there can report its turn back. Screen 10 is the contract that keeps
 * them apart — a dead tunnel stops the reporting, not the terminal — so the chip never turns green on
 * "ssh works" alone, and never turns red on a forward that failed over a connection that did not.
 */
export interface MachineStatusInput {
  label: string;
  tunnel: TunnelStatus | null;
  hooks: MachineHooks | null;
  /** The operator pressed Putuskan; nothing reconnects until they ask. */
  disconnected?: boolean;
}

export type MachineTone = "ok" | "warn" | "bad" | "off";

export interface MachineStatusRow {
  tone: MachineTone;
  title: string;
  sub: string;
  /** What ssh or the installer said, for when the summary is not enough. */
  detail?: string | null;
}

export interface MachineStatusView {
  tone: MachineTone;
  /** The chip's text. */
  chip: string;
  /** The chip's tooltip, one line plus the raw detail. */
  title: string;
  connection: MachineStatusRow;
  wayHome: MachineStatusRow;
  /** Set only when ssh could not get in: the one sentence and one action of screen 05. */
  failure: RemoteFailure | null;
  /** The action the popover leads with, or none when there is nothing to fix. */
  primary: "retry" | "reconnect" | null;
}

const CONNECTED: MachineStatusRow = { tone: "ok", title: "Terhubung", sub: "ssh masuk, terminal bisa dibuka" };

export function machineStatusView({ label, tunnel, hooks, disconnected }: MachineStatusInput): MachineStatusView {
  if (disconnected) {
    return {
      tone: "off",
      chip: `${label} · terputus`,
      title: `${label} · diputus — terminal yang sudah jalan tetap hidup`,
      connection: {
        tone: "off",
        title: "Diputus",
        sub: "Terminal yang sudah jalan tetap hidup; agen berhenti melapor sampai disambung lagi",
      },
      wayHome: { tone: "off", title: "Tertutup", sub: "Dibuka lagi saat disambung" },
      failure: null,
      primary: "reconnect",
    };
  }

  const preparing = (connection: MachineStatusRow, wayHome: MachineStatusRow): MachineStatusView => ({
    tone: "warn",
    chip: `${label} · menyiapkan…`,
    title: `${label} · menyiapkan jalan pulang…`,
    connection,
    wayHome,
    failure: null,
    primary: null,
  });

  if (!tunnel || (tunnel.state === "closed" && !tunnel.detail)) {
    return preparing(
      { tone: "warn", title: "Menyambung…", sub: "Membuka ssh ke mesin ini" },
      { tone: "warn", title: "Menunggu sambungan", sub: "Dibuka setelah ssh masuk" },
    );
  }

  if (tunnel.state !== "open" && isConnectFailure(tunnel.detail)) {
    const failure = describeRemoteFailure(tunnel.detail, label);
    return {
      tone: "bad",
      chip: `${label} · gagal`,
      title: `${failure.title}\n${failure.detail}`,
      connection: { tone: "bad", title: "Gagal", sub: failure.title, detail: failure.detail },
      wayHome: { tone: "off", title: "Menunggu sambungan", sub: "Dibuka setelah ssh masuk" },
      failure,
      primary: "retry",
    };
  }

  if (tunnel.state !== "open") {
    return {
      tone: "warn",
      chip: `${label} · tak melapor`,
      title: `${label} · jalan pulang terputus — terminal tetap jalan, agen berhenti melapor${tunnel.detail ? `\n${tunnel.detail}` : ""}`,
      connection: CONNECTED,
      wayHome: {
        tone: "warn",
        title: "Terputus",
        sub: "Terminal tetap jalan, agen berhenti melapor",
        detail: tunnel.detail,
      },
      failure: null,
      primary: "retry",
    };
  }

  if (hooks?.state === "pending") {
    return preparing(CONNECTED, { tone: "warn", title: "Memasang hook…", sub: "Agar agen bisa melapor selesai" });
  }

  if (hooks?.state === "failed") {
    return {
      tone: "warn",
      chip: `${label} · tak melapor`,
      title: `${label} · jalan pulang terbuka, tapi hook gagal dipasang — agen tidak akan melapor selesai${hooks.detail ? `\n${hooks.detail}` : ""}`,
      connection: CONNECTED,
      wayHome: {
        tone: "warn",
        title: "Hook gagal dipasang",
        sub: "Agen tidak akan melapor selesai",
        detail: hooks.detail,
      },
      failure: null,
      primary: "retry",
    };
  }

  return {
    tone: "ok",
    chip: label,
    title: `${label} · agen di mesin ini bisa melapor balik`,
    connection: CONNECTED,
    wayHome: { tone: "ok", title: "Terbuka", sub: `Agen bisa melapor balik · port ${tunnel.ports.join(", ") || "—"}` },
    failure: null,
    primary: null,
  };
}
