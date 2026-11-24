import type { CellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import type { LegacyTerminalSessionAdapter } from "./legacy-terminal-session-adapter";

let activeAdapter: LegacyTerminalSessionAdapter | null = null;
const pendingBuses = new Set<CellBus>();
const activeBusDisposers = new Map<CellBus, () => void>();

export function installTerminalV2LegacySessionAdapter(
  adapter: LegacyTerminalSessionAdapter,
): () => void {
  activeAdapter = adapter;
  for (const bus of pendingBuses) attachBusToAdapter(bus, adapter);

  return () => {
    if (activeAdapter !== adapter) return;
    for (const dispose of activeBusDisposers.values()) dispose();
    activeBusDisposers.clear();
    activeAdapter = null;
  };
}

export function attachTerminalV2LegacyCellBus(bus: CellBus): () => void {
  pendingBuses.add(bus);
  if (activeAdapter) attachBusToAdapter(bus, activeAdapter);

  return () => {
    pendingBuses.delete(bus);
    activeBusDisposers.get(bus)?.();
    activeBusDisposers.delete(bus);
  };
}

export function getTerminalV2LegacySessionAdapter(): LegacyTerminalSessionAdapter | null {
  return activeAdapter;
}

export function clearTerminalV2LegacySessionAdapterForTests(): void {
  for (const dispose of activeBusDisposers.values()) dispose();
  activeBusDisposers.clear();
  pendingBuses.clear();
  activeAdapter = null;
}

function attachBusToAdapter(bus: CellBus, adapter: LegacyTerminalSessionAdapter): void {
  if (activeBusDisposers.has(bus)) return;
  activeBusDisposers.set(bus, adapter.attachCellBus(bus));
}
