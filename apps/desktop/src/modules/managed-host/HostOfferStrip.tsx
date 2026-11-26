/**
 * A strip over a pane that runs as a plain `ssh -t` (plans/ssh-pane-durability, phase 5).
 *
 * Without a Lotus host on the machine, a Canvas terminal offers to install one: Canvas has no
 * workspace banner. Once the machine has a host, every such pane offers to open again inside it,
 * where a dropped link no longer ends its process. Opening again ends the process that runs now,
 * so a busy pane says so on its button. Mockup: mockups/ssh-host-install.html.
 */
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlainSshMachine } from "@/lib/plain-ssh-sessions";
import "@/styles/ssh-link-strip.css";
import {
  hostKey,
  installHost,
  managedHostEnabled,
  offerFor,
  probeHost,
  useManagedHosts,
  type HostEntry,
  type HostTarget,
} from "./managed-host";

export type HostOffer = "none" | "install" | "installing" | "failed" | "reopen";

/**
 * What the strip offers for a plain ssh pane. `canvas` is the surface without a workspace banner:
 * there the strip also carries the install's progress and failure, which Code's banner shows.
 */
export function hostOfferFor(entry: HostEntry | undefined, appVersion: string | null, canvas: boolean): HostOffer {
  if (!entry) return "none";
  if (entry.step) return canvas && entry.step !== "remove" ? "installing" : "none";
  if (entry.failure) return canvas && entry.status?.kind === "none" ? "failed" : "none";
  const status = entry.status;
  if (!status) return "none";
  if (status.kind !== "none") return status.running ? "reopen" : "none";
  if (!canvas || entry.notNow || entry.dontAsk) return "none";
  return offerFor(status, appVersion) === "install" ? "install" : "none";
}

/** Sessions whose strip the user closed. Kept for the run: the session id never comes back. */
const dismissed = new Set<string>();

export function HostOfferStrip({
  sessionId,
  canvas = false,
  busy = false,
  onRelaunch,
}: {
  sessionId: string | null | undefined;
  /** A Canvas terminal: it also offers the install, since Canvas has no workspace banner. */
  canvas?: boolean;
  /** The pane's agent is working now: opening again stops it. */
  busy?: boolean;
  onRelaunch?: () => void;
}) {
  const machine = usePlainSshMachine(sessionId);
  const { appVersion, hosts } = useManagedHosts();
  const [closed, setClosed] = useState(() => (sessionId ? dismissed.has(sessionId) : false));
  const [pressedOn, setPressedOn] = useState<string | null>(null);
  const enabled = managedHostEnabled();
  const host = machine?.host ?? null;
  const user = machine?.user ?? undefined;
  const port = machine?.port ?? undefined;

  // Code's banner asks the machine already; a Canvas terminal has no banner to do it.
  useEffect(() => {
    if (enabled && host) void probeHost({ host, user, port });
  }, [enabled, host, user, port]);

  if (!enabled || !host || !sessionId || closed || dismissed.has(sessionId)) return null;
  const target: HostTarget = { host, user, port };
  const offer = hostOfferFor(hosts[hostKey(target)], appVersion, canvas);
  if (offer === "none") return null;
  if (offer === "reopen" && !onRelaunch) return null;

  const close = (
    <button
      type="button"
      className="ws-link-strip__close"
      aria-label="Tutup"
      onClick={() => {
        dismissed.add(sessionId);
        setClosed(true);
      }}
    >
      <X size={12} />
    </button>
  );

  if (offer === "installing") {
    return (
      <div className="ws-link-strip" data-tone="neutral" role="status">
        <span className="ws-link-strip__spinner" aria-hidden="true" />
        <span className="ws-link-strip__text">Memasang Lotus host di {host}…</span>
      </div>
    );
  }

  if (offer === "failed") {
    const entry = hosts[hostKey(target)];
    return (
      <div className="ws-link-strip" data-tone="danger" role="alert">
        <span className="ws-link-strip__text" title={entry?.failure ?? undefined}>
          Pasang host gagal. Tidak ada yang tertinggal di VPS.
        </span>
        <button type="button" className="ws-link-strip__action" onClick={() => void installHost(target)}>
          Coba lagi
        </button>
        {close}
      </div>
    );
  }

  if (offer === "install") {
    return (
      <div className="ws-link-strip" data-tone="neutral" role="status">
        <span className="ws-link-strip__text">VPS ini belum punya Lotus host. Kalau koneksi putus, proses ikut berhenti.</span>
        <button type="button" className="ws-link-strip__action" data-primary="true" onClick={() => void installHost(target)}>
          Pasang host
        </button>
        {close}
      </div>
    );
  }

  const pressed = pressedOn === sessionId;
  return (
    <div className="ws-link-strip" data-tone="success" role="status">
      <span className="ws-link-strip__text">
        <b>Host terpasang.</b> {busy ? "Proses yang jalan sekarang akan berhenti." : "Buka lagi agar pane ini tahan putus."}
      </span>
      <button
        type="button"
        className="ws-link-strip__action"
        data-primary="true"
        disabled={pressed}
        onClick={() => {
          if (pressed) return;
          setPressedOn(sessionId);
          onRelaunch?.();
        }}
      >
        {busy ? "Hentikan & buka lagi" : "Buka lagi"}
      </button>
      {close}
    </div>
  );
}
