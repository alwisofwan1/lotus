"use client";
import { useSyncExternalStore } from "react";
import { contextBusRegistry } from "../services/context-bus-registry";
import type { ContextArtifact } from "../services/context-bus-record";

/** Live artifacts on one Context Bus node, via the external-store seam (stable list reference). */
export function useContextBusArtifacts(busNodeId: string): ContextArtifact[] {
  return useSyncExternalStore(
    (onChange) => contextBusRegistry.subscribe(busNodeId, onChange),
    () => contextBusRegistry.list(busNodeId),
  );
}
