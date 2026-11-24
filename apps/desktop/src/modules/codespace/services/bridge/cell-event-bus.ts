import type { ProviderId } from "@/modules/codespace/components/types";
import type { TerminalInputEvent } from "@/modules/codespace/services/terminal-input-events";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";

export type CellBusEvents = {
  "terminal:spawned": {
    paneId: string;
    workspaceId: string;
    cwd: string;
    provider?: ProviderId | "shell";
  };
  "terminal:exited": { paneId: string; workspaceId: string };
  "terminal:input": TerminalInputEvent;
  "terminal:output": { paneId: string; workspaceId: string; data: string };
  "terminal:status": { paneId: string; status: TerminalRuntimeStatus };
  "bridge:input": {
    paneId: string;
    workspaceId: string;
    prompt: string;
  };
  "bridge:completed": {
    paneId: string;
    workspaceId: string;
    status: "completed" | "failed";
    preview: string;
  };
  "workbench:file-opened": { workspaceId: string; path: string };
  "workbench:file-closed": { workspaceId: string; path: string };
  "workbench:file-changed": { workspaceId: string; path: string; dirty: boolean };
  "orchestrator:dispatch": {
    paneId: string;
    workspaceId: string;
    kind: "send-message" | "kill";
    payload?: string;
  };
  "orchestrator:request-spawn": {
    workspaceId: string;
    agentCommand: string;
    provider?: ProviderId;
  };
};

export type CellBusEventName = keyof CellBusEvents;

export type CellBusListener<K extends CellBusEventName> = (payload: CellBusEvents[K]) => void;

export type CellBus = {
  on: <K extends CellBusEventName>(event: K, listener: CellBusListener<K>) => () => void;
  off: <K extends CellBusEventName>(event: K, listener: CellBusListener<K>) => void;
  emit: <K extends CellBusEventName>(event: K, payload: CellBusEvents[K]) => void;
  clear: () => void;
  listenerCount: (event: CellBusEventName) => number;
};

export function createCellBus(): CellBus {
  const listeners = new Map<CellBusEventName, Set<CellBusListener<CellBusEventName>>>();

  function on<K extends CellBusEventName>(event: K, listener: CellBusListener<K>): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener as CellBusListener<CellBusEventName>);
    return () => off(event, listener);
  }

  function off<K extends CellBusEventName>(event: K, listener: CellBusListener<K>): void {
    const set = listeners.get(event);
    if (!set) return;
    set.delete(listener as CellBusListener<CellBusEventName>);
    if (set.size === 0) listeners.delete(event);
  }

  function emit<K extends CellBusEventName>(event: K, payload: CellBusEvents[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        (listener as CellBusListener<K>)(payload);
      } catch (err) {
        console.error(`[cell-bus] listener for ${event} threw`, err);
      }
    }
  }

  function clear(): void {
    listeners.clear();
  }

  function listenerCount(event: CellBusEventName): number {
    return listeners.get(event)?.size ?? 0;
  }

  return { on, off, emit, clear, listenerCount };
}
