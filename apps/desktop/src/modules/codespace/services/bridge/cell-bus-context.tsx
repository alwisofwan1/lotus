"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  attachCellBus,
  closeTerminalSession,
  writeTerminalSession,
} from "@/modules/codespace/services/terminal-session-registry";
import { encodeTerminalTextSubmission } from "@/modules/codespace/services/terminal-submit";
import {
  createCellBus,
  type CellBus,
  type CellBusEventName,
  type CellBusEvents,
  type CellBusListener,
} from "./cell-event-bus";
import { createFleetOutputTap, type FleetOutputTap } from "./fleet-output-tap";

export const CellBusContext = createContext<CellBus | null>(null);

// (07) One tap per bus, shared by every consumer, provided alongside it. Previously
// `useMcpFleetPush` and `useFleetIdentitySync` each called `createFleetOutputTap(bus)`
// themselves: every PTY byte got parsed twice, held in two separate 4KB buffers / 128-byte
// switch windows, and — since each tap only starts filling from its own mount point — a tap
// created later could permanently miss a banner the other tap already saw, disagreeing about
// a pane's provider forever. A single tap living as long as the bus closes both gaps.
const CellOutputTapContext = createContext<FleetOutputTap | null>(null);

/**
 * Owns the shared output tap's create/dispose lifecycle (09). Fixes a StrictMode-only
 * regression from slice 07: `useMemo(() => createFleetOutputTap(bus), [bus])` created the tap
 * during RENDER, with disposal in a SEPARATE effect. React StrictMode (dev) mounts every
 * component, cleans it up, then mounts it again — WITHOUT re-rendering in between. So the
 * disposal effect's cleanup killed the only tap that ever existed, and the replayed mount got
 * the exact same (now-dead, unsubscribed) object back from `useMemo` — which never recomputes
 * just because an effect replayed, only when its deps (`[bus]`) actually change. The tap stayed
 * disposed for the rest of the session: live symptom was two Claude Code panes reporting
 * `provider=shell`, `last_output_preview` empty — the tap received zero output events after a
 * StrictMode double-mount.
 *
 * Fix: creation moves INSIDE the same effect that disposes it, so the two always live and die
 * together — a StrictMode replay disposes tapA in cleanup, then the replayed mount creates a
 * live tapB and hands it to consumers via `setTap`. The very FIRST render (before ANY effect
 * has run) still needs a real, non-null tap — `useCellOutputTap()` must never return
 * null/undefined — so the initial value comes from a lazy `useState` initializer, not from
 * state starting at `null`.
 */
function useOwnedFleetOutputTap(bus: CellBus): FleetOutputTap {
  const [tap, setTap] = useState<FleetOutputTap>(() => createFleetOutputTap(bus));
  const disposedRef = useRef(false);

  useEffect(() => {
    // On an ordinary first run, `tap` (from this render) is still the live one nothing has
    // disposed yet — nothing to recreate. Only when this effect's OWN prior cleanup already
    // ran (disposedRef true — exactly the StrictMode mount→cleanup→mount replay, or a real
    // `bus` identity change) does the current `tap` need replacing before anyone reads it.
    const owned = disposedRef.current ? createFleetOutputTap(bus) : tap;
    if (owned !== tap) {
      disposedRef.current = false;
      setTap(owned);
    }
    // JEBAKAN (07): only the owner disposes. `tap` is shared by every consumer via context —
    // if a consuming hook called `tap.dispose()` on its own unmount (as both used to), it
    // would clear the buffers/provider map/switch window out from under every OTHER consumer
    // still mounted. Disposal lives here, once, keyed to the exact tap THIS effect run made
    // (or adopted) — never a stale reference from a different render.
    return () => {
      disposedRef.current = true;
      owned.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus]);

  return tap;
}

export type CellBusProviderProps = {
  workspaceId: string | null | undefined;
  onRequestSpawn?: (agentCommand: string, providerId?: string) => void;
  children: ReactNode;
};

export function CellBusProvider({ onRequestSpawn, children }: CellBusProviderProps) {
  // Bus identity is stable across workspace switches so subscribers keep receiving in-flight
  // terminal:* events for background workspaces. Cross-workspace isolation is enforced by the
  // workspaceId field in every event payload, not by tearing the bus down.
  const bus = useMemo(() => createCellBus(), []);
  // Tied to `bus`'s own lifecycle (not a separate mount/unmount of its own) so the two never
  // drift apart — if `bus` identity ever changes, the old tap goes with the old bus and a
  // fresh one is made for the new one. See useOwnedFleetOutputTap's docstring (09) for why
  // this can no longer be a plain useMemo.
  const tap = useOwnedFleetOutputTap(bus);
  const onRequestSpawnRef = useRef(onRequestSpawn);
  useEffect(() => {
    onRequestSpawnRef.current = onRequestSpawn;
  }, [onRequestSpawn]);

  useEffect(() => {
    const detach = attachCellBus(bus);
    const unsubDispatch = bus.on("orchestrator:dispatch", (payload) => {
      if (payload.kind === "send-message" && typeof payload.payload === "string") {
        writeTerminalSession(payload.paneId, encodeTerminalTextSubmission(payload.payload), {
          origin: "bridge",
          intent: "conversation-prompt",
          submitted: true,
          promptText: payload.payload,
        });
      } else if (payload.kind === "kill") {
        closeTerminalSession(payload.paneId);
      }
    });
    const unsubSpawn = bus.on("orchestrator:request-spawn", (payload) => {
      onRequestSpawnRef.current?.(payload.agentCommand, payload.provider);
    });
    return () => {
      unsubDispatch();
      unsubSpawn();
      detach();
      bus.clear();
    };
  }, [bus]);

  return (
    <CellBusContext.Provider value={bus}>
      <CellOutputTapContext.Provider value={tap}>{children}</CellOutputTapContext.Provider>
    </CellBusContext.Provider>
  );
}

export function useCellBus(): CellBus {
  const bus = useContext(CellBusContext);
  if (!bus) {
    throw new Error("useCellBus must be used within <CellBusProvider>");
  }
  return bus;
}

/** The single output tap shared by every consumer under this provider — see (07) above. */
export function useCellOutputTap(): FleetOutputTap {
  const tap = useContext(CellOutputTapContext);
  if (!tap) {
    throw new Error("useCellOutputTap must be used within <CellBusProvider>");
  }
  return tap;
}

export function useCellBusEvent<K extends CellBusEventName>(
  event: K,
  listener: CellBusListener<K>,
  deps: readonly unknown[] = [],
): void {
  const bus = useCellBus();
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(() => {
    const unsub = bus.on(event, (payload: CellBusEvents[K]) => listenerRef.current(payload));
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, event, ...deps]);
}
