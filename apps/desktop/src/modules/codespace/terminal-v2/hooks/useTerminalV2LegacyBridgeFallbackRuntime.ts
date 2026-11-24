"use client";

import {
  useLegacyTerminalRuntime,
  type UseLegacyTerminalRuntimeOptions,
} from "@/modules/codespace/hooks/useLegacyTerminalRuntime";
import { useTerminalV2PaneRuntime } from "./useTerminalV2PaneRuntime";

export type UseTerminalV2LegacyBridgeFallbackRuntimeOptions = UseLegacyTerminalRuntimeOptions;

/**
 * Explicit emergency/fallback bridge from Terminal V2 UI to the legacy runtime.
 *
 * Default local Terminal V2 panes use `useTerminalV2NativeRuntime`; this hook is
 * only for named fallback routes such as the localStorage emergency rollback.
 */
export function useTerminalV2LegacyBridgeFallbackRuntime(
  options: UseTerminalV2LegacyBridgeFallbackRuntimeOptions,
) {
  const paneRuntime = useTerminalV2PaneRuntime(options);
  const legacyRuntime = useLegacyTerminalRuntime({
    ...options,
    ...paneRuntime.legacyOptions,
  });

  return {
    ...legacyRuntime,
    focus: paneRuntime.focus,
  };
}
