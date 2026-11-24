"use client";
import { useEffect, useRef, useState } from "react";
import {
  machineDisconnect,
  machineInstallHooks,
  machineTunnelClose,
  machineTunnelOpen,
  machineTunnelStatus,
  type TunnelStatus,
} from "@/lib/tauri-api";
import { machineKey, sshTarget, type Machine } from "../services/machine";

/**
 * How often the tunnel is re-asked while a remote project is open.
 *
 * ssh notices a dead network in ~45 s (`ServerAliveInterval=15`, `CountMax=3`), so polling much
 * faster would only ask a question whose answer cannot have changed. Eight seconds keeps the gap
 * between "the cable came out" and the operator seeing it in the same order of magnitude as ssh's
 * own detection, without a process check every second for the whole session.
 */
const POLL_MS = 8_000;

/**
 * Whether this machine can actually report an agent's turn back, which is a second thing from
 * whether the tunnel is up.
 *
 * `pending` is the honest answer while the install is in flight, and for a machine whose tunnel has
 * not opened yet — "not asked" must never render as "not installed".
 */
export interface MachineHooks {
  state: "pending" | "ready" | "failed";
  detail?: string | null;
}

export interface MachineTunnel {
  /** `null` when the active project is on this machine — there is nothing to tunnel. */
  status: TunnelStatus | null;
  /** `null` for a local project, for the same reason. */
  hooks: MachineHooks | null;
  /** Ask again right now, for a retry button. Also reconnects a machine the operator let go of. */
  refresh: () => void;
  /** Let go of the machine until `refresh` — without this the poll would reopen it in eight seconds. */
  disconnect: () => void;
  /** Whether the operator let go of the machine with `disconnect`. */
  disconnected: boolean;
}

/**
 * Hold the way home open for as long as a remote project is the active one.
 *
 * **Scope is the project, not the node, and that is a decision.** The ticket describes one tunnel
 * per machine, closed when its last node closes; a board only ever has one machine, so tying the
 * tunnel to the active project gets the same lifetime with none of the reference counting — and
 * without the failure mode where a miscounted node leaves a tunnel open forever.
 *
 * Opening is idempotent in Rust, so a re-render or a second caller costs nothing.
 */
export function useMachineTunnel(location: Machine | null): MachineTunnel {
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [hooks, setHooks] = useState<MachineHooks | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Remembered by machine, so switching to another project is not carrying the choice over to it.
  const [disconnectedKey, setDisconnectedKey] = useState<string | null>(null);

  // Keyed by value, not identity: the location object is rebuilt on every render of the board, and
  // an identity dependency would tear the tunnel down and back up on each one.
  const key = machineKey(location);
  const keyRef = useRef(key);
  keyRef.current = key;
  const disconnected = key !== "" && disconnectedKey === key;

  useEffect(() => {
    if (!location) {
      setStatus(null);
      setHooks(null);
      return;
    }
    const target = sshTarget(location);
    if (disconnected) {
      void machineDisconnect(target).then(setStatus).catch(() => {});
      return;
    }

    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Once per machine, not once per poll: installing is idempotent but still costs an ssh round
    // trip, and the poll runs every eight seconds for as long as the board is open.
    let installed = false;

    const settle = (next: TunnelStatus) => {
      if (live) setStatus(next);
    };

    /**
     * Put the hook on the machine, now that there is a way home for it to report through.
     *
     * Deliberately after the tunnel and not before: the script posts to a loopback port that only
     * exists on the far side once `ssh -R` is up, so installing first would leave a window where an
     * agent fires a hook into nothing.
     */
    const installHooks = () => {
      if (installed || !live) return;
      installed = true;
      setHooks({ state: "pending" });
      machineInstallHooks(target)
        .then(() => {
          if (live) setHooks({ state: "ready" });
        })
        .catch((error: unknown) => {
          // A failure here does not touch the tunnel: ssh is up, and terminals keep working. What
          // stops is agents reporting their turn, so it is reported in its own terms.
          installed = false;
          if (live) {
            setHooks({
              state: "failed",
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        });
    };

    const poll = () => {
      machineTunnelStatus(target)
        .then((next) => {
          settle(next);
          if (next.state === "open") {
            installHooks();
            return undefined;
          }
          // A tunnel that died is reopened rather than merely reported: the operator asked for this
          // machine by opening the project, and a silent agent is the cost of leaving it down.
          if (live) {
            return machineTunnelOpen(target)
              .then((reopened) => {
                settle(reopened);
                if (reopened.state === "open") installHooks();
              })
              .catch(() => {});
          }
          return undefined;
        })
        .catch((error: unknown) => {
          settle({
            state: "failed",
            ports: [],
            detail: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (live) timer = setTimeout(poll, POLL_MS);
        });
    };

    machineTunnelOpen(target)
      .then((next) => {
        settle(next);
        if (next.state === "open") installHooks();
      })
      .catch((error: unknown) => {
        settle({
          state: "failed",
          ports: [],
          detail: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (live) timer = setTimeout(poll, POLL_MS);
      });

    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      // Closing on the way out is what keeps `ps` clean: a board switched away from must not leave
      // an `ssh -R` holding a port on the far machine.
      void machineTunnelClose(target).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for the location value
  }, [key, attempt, disconnected]);

  return {
    status,
    hooks,
    refresh: () => {
      setDisconnectedKey(null);
      setAttempt((n) => n + 1);
    },
    disconnect: () => setDisconnectedKey(keyRef.current),
    disconnected,
  };
}
