"use client";

import { useEffect, useState } from "react";
import type { TerminalV2RendererDebugSnapshot } from "../rendering/terminal-v2-renderer-coordinator";
import type { TerminalV2RuntimeDiagnosticsSnapshot } from "../runtime/terminal-v2-runtime";

export const TERMINAL_V2_RENDERER_DIAGNOSTICS_STORAGE_KEY = "lotus:terminal-v2-renderer-diagnostics";

export function useTerminalV2RendererDiagnosticsEnabled(environment = process.env.NODE_ENV): boolean {
  const [enabled, setEnabled] = useState(() => readDiagnosticsEnabled(environment));

  useEffect(() => {
    setEnabled(readDiagnosticsEnabled(environment));
  }, [environment]);

  return enabled;
}

type RendererDiagnosticsRuntime = {
  getRendererDebugSnapshot(): TerminalV2RendererDebugSnapshot;
};

type RuntimeDiagnosticsRuntime = {
  getRuntimeDiagnosticsSnapshot(): TerminalV2RuntimeDiagnosticsSnapshot;
};

export type UseTerminalV2RendererDiagnosticsOptions = {
  enabled: boolean;
  environment?: string;
  runtime: RendererDiagnosticsRuntime | null | undefined;
  refreshMs?: number;
};

export function useTerminalV2RendererDiagnostics({
  enabled,
  environment = process.env.NODE_ENV,
  runtime,
  refreshMs = 1_000,
}: UseTerminalV2RendererDiagnosticsOptions): TerminalV2RendererDebugSnapshot | null {
  useDiagnosticsRefresh({ enabled, environment, refreshMs, runtime });
  return readSnapshot({ enabled, environment, runtime });
}

export type UseTerminalV2RuntimeDiagnosticsOptions = {
  enabled: boolean;
  environment?: string;
  runtime: RuntimeDiagnosticsRuntime | null | undefined;
  refreshMs?: number;
};

export function useTerminalV2RuntimeDiagnostics({
  enabled,
  environment = process.env.NODE_ENV,
  runtime,
  refreshMs = 1_000,
}: UseTerminalV2RuntimeDiagnosticsOptions): TerminalV2RuntimeDiagnosticsSnapshot | null {
  useDiagnosticsRefresh({ enabled, environment, refreshMs, runtime });
  if (!enabled || environment === "production" || !runtime) return null;
  return runtime.getRuntimeDiagnosticsSnapshot();
}

function useDiagnosticsRefresh({
  enabled,
  environment,
  refreshMs,
  runtime,
}: {
  enabled: boolean;
  environment: string | undefined;
  refreshMs: number;
  runtime: unknown;
}) {
  const [refreshTick, setRefreshTick] = useState(0);
  void refreshTick;

  useEffect(() => {
    if (!enabled || environment === "production" || !runtime) return undefined;
    const interval = window.setInterval(() => {
      setRefreshTick((current) => current + 1);
    }, refreshMs);
    return () => window.clearInterval(interval);
  }, [enabled, environment, refreshMs, runtime]);
}

function readDiagnosticsEnabled(environment: string | undefined): boolean {
  if (environment === "production" || typeof window === "undefined") return false;
  return window.localStorage.getItem(TERMINAL_V2_RENDERER_DIAGNOSTICS_STORAGE_KEY) === "1";
}

function readSnapshot({
  enabled,
  environment,
  runtime,
}: Pick<UseTerminalV2RendererDiagnosticsOptions, "enabled" | "environment" | "runtime">) {
  if (!enabled || environment === "production" || !runtime) return null;
  return runtime.getRendererDebugSnapshot();
}
