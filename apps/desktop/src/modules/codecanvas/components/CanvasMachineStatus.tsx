"use client";
import { useEffect, useRef, useState } from "react";
import { listSshHosts, machineAccessLogin, type TunnelStatus } from "@/lib/tauri-api";
import type { MachineHooks } from "../hooks/useMachineTunnel";
import { useDockedOccluder } from "../hooks/useDockedOccluder";
import { machineStatusView, type MachineStatusRow } from "../services/machine-status";

/**
 * The machine a remote project lives on, as a chip beside the project name and a popover behind it
 * (board 22). The same component sits in the Top Bar and in the docked command bar, so the status is
 * visible whichever mode the operator chose — before board 22 the command bar showed none at all.
 */
export interface CanvasMachineStatusProps {
  label: string;
  /** The ssh alias, used to find a Cloudflare Access sign-in for "Login lagi". */
  host: string;
  tunnel: TunnelStatus | null;
  hooks: MachineHooks | null;
  disconnected?: boolean;
  /** Coba lagi, and reconnecting after Putuskan. */
  onRetry: () => void;
  /** Cek ulang mesin: drop the cached probe and ask the machine again. */
  onRecheck: () => Promise<unknown>;
  /** Putuskan (screen 09). */
  onDisconnect: () => void;
}

interface Props extends CanvasMachineStatusProps {
  /** Which way the popover opens: "up" from the bottom command bar, "down" from the Top Bar. */
  placement: "up" | "down";
}

export function CanvasMachineStatus({ placement, onRetry, onRecheck, onDisconnect, host, ...input }: Props) {
  const view = machineStatusView(input);
  const [open, setOpen] = useState(false);
  const [rechecking, setRechecking] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [accessHostname, setAccessHostname] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Floats over the canvas like the project menu, so a browser node's native WebView must clip
  // around it rather than paint over it — see CanvasProjectMenu for the edge/force reasoning.
  useDockedOccluder(popRef, open, { force: true, edge: placement === "up" ? "bottom" : "top" });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Only a machine behind Cloudflare Access has a sign-in to redo, and only a failed connection
  // needs one — so the lookup waits for both rather than reading ~/.ssh/config on every render.
  const failed = view.tone === "bad";
  useEffect(() => {
    if (!open || !failed) return;
    let live = true;
    listSshHosts()
      .then((hosts) => {
        const match = hosts.find((entry) => entry.alias === host);
        if (live) setAccessHostname(match?.accessHostname ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, failed, host]);

  const recheck = () => {
    setRechecking("busy");
    onRecheck()
      .then(() => setRechecking("done"))
      .catch(() => setRechecking("failed"));
  };

  return (
    <div className="canvas-machine" ref={ref}>
      <button
        type="button"
        className="canvas-topbar-machine"
        data-tone={view.tone}
        title={view.title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="canvas-topbar-machine-dot" aria-hidden />
        {view.chip}
      </button>

      {open && (
        <div
          ref={popRef}
          className={`canvas-project-dropdown canvas-machine-pop${placement === "up" ? " canvas-project-dropdown--up" : ""}`}
          role="dialog"
          aria-label={`Mesin ${input.label}`}
        >
          {view.failure ? (
            <div className="canvas-machine-failure">
              <strong>{view.failure.title}</strong>
              <span>{view.failure.action}</span>
            </div>
          ) : null}
          <Row name="Sambungan" row={view.connection} />
          <Row name="Jalan pulang" row={view.wayHome} />
          <div className="canvas-project-sep" role="separator" />
          <div className="canvas-machine-actions">
            {failed && accessHostname ? (
              <button
                type="button"
                className="canvas-project-action"
                onClick={() => void machineAccessLogin(accessHostname).catch(() => {})}
              >
                Login lagi
              </button>
            ) : null}
            {view.primary === "reconnect" ? (
              <button type="button" className="canvas-project-action" data-primary onClick={onRetry}>
                Sambung lagi
              </button>
            ) : (
              <>
                {failed ? null : (
                <button type="button" className="canvas-project-action" disabled={rechecking === "busy"} onClick={recheck}>
                  {rechecking === "busy"
                    ? "Memeriksa…"
                    : rechecking === "done"
                      ? "Cek ulang mesin · selesai"
                      : rechecking === "failed"
                        ? "Cek ulang mesin · gagal"
                        : "Cek ulang mesin"}
                </button>
                )}
                {view.primary === "retry" ? (
                  <button type="button" className="canvas-project-action" data-primary onClick={onRetry}>
                    Coba lagi
                  </button>
                ) : (
                  <button
                    type="button"
                    className="canvas-project-action"
                    onClick={() => {
                      setOpen(false);
                      onDisconnect();
                    }}
                  >
                    Putuskan
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ name, row }: { name: string; row: MachineStatusRow }) {
  return (
    <div className="canvas-machine-row" data-tone={row.tone}>
      <span className="canvas-topbar-machine-dot" aria-hidden />
      <span className="canvas-machine-row-name">{name}</span>
      <span className="canvas-machine-row-body">
        <strong>{row.title}</strong>
        <span>{row.sub}</span>
        {row.detail ? <code>{row.detail}</code> : null}
      </span>
    </div>
  );
}
