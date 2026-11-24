"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTheme } from "@/contexts/ThemeContext";
import {
  TERMINAL_RUNTIME_V2_FLAG,
  TERMINAL_V2_POOLED_DOM_RENDERER_FLAG,
  resolveFeatureFlag,
} from "@/lib/feature-flags";
import { getSettings, isTauri } from "@/lib/tauri-api";
import {
  LOTUS_SETTINGS_CHANGED_EVENT,
  readLotusSettingsChangedDetail,
} from "@/modules/settings/services/settings-events";
import type { ClaudeSettings } from "@/modules/settings/types";
import { resolveCodeSpaceTerminalRenderTheme } from "@/modules/codespace/services/codespace-terminal-render-theme";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_KEY,
  normalizeTerminalFontSize,
} from "@/modules/codespace/services/terminal-settings";
import {
  createLegacyTerminalSessionAdapter,
} from "../compat/legacy-terminal-session-adapter";
import {
  mountTerminalV2PooledRendererUiAdapter,
  resolveTerminalV2PooledRendererUiPolicyInput,
} from "../components/terminal-v2-pooled-renderer-ui-adapter";
import { loadDefaultPooledXtermRendererFactory } from "../hooks/terminal-v2-pooled-renderer-loader";
import { resolveTerminalV2PooledDomRendererPolicy } from "../rendering/terminal-v2-pooled-dom-renderer-policy";
import type { TerminalV2PooledRendererAppearance } from "../rendering/terminal-v2-pooled-dom-slot";
import type { TerminalV2PooledDomSlotFactory } from "../rendering/terminal-v2-pooled-dom-slot-factory";
import {
  installTerminalV2LegacySessionAdapter,
} from "../compat/terminal-session-registry-bridge";
import {
  createTerminalV2Runtime,
  type TerminalV2Runtime,
} from "./terminal-v2-runtime";

type TerminalV2RuntimeContextValue = {
  featureEnabled: boolean;
  pooledRendererEnabled: boolean;
  activationRequested: boolean;
  active: boolean;
  runtime: TerminalV2Runtime | null;
  requestActivation: () => void;
};

const TerminalV2RuntimeContext = createContext<TerminalV2RuntimeContextValue | null>(null);

export function TerminalV2RuntimeProvider({
  activationRequested = false,
  children,
}: {
  activationRequested?: boolean;
  children: React.ReactNode;
}) {
  const [featureEnabled, setFeatureEnabled] = useState(() => (
    resolveFeatureFlag(undefined, TERMINAL_RUNTIME_V2_FLAG)
  ));
  const [pooledRendererEnabled, setPooledRendererEnabled] = useState(() => (
    resolveFeatureFlag(undefined, TERMINAL_V2_POOLED_DOM_RENDERER_FLAG)
  ));
  const [terminalFontSize, setTerminalFontSize] = useState(DEFAULT_TERMINAL_FONT_SIZE);
  const { theme, themeId } = useTheme();
  const terminalTheme = useMemo(
    () => resolveCodeSpaceTerminalRenderTheme(theme),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeId],
  );
  const pooledAppearanceRef = useRef<TerminalV2PooledRendererAppearance>({
    theme: terminalTheme,
    fontSize: terminalFontSize,
  });
  const pooledSlotFactoryRef = useRef<TerminalV2PooledDomSlotFactory | null>(null);
  const [requested, setRequested] = useState(false);

  const requestActivation = useCallback(() => {
    setRequested(true);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (cancelled) return;
        setFeatureEnabled(resolveFeatureFlag(settings as ClaudeSettings, TERMINAL_RUNTIME_V2_FLAG));
        setPooledRendererEnabled(resolveFeatureFlag(settings as ClaudeSettings, TERMINAL_V2_POOLED_DOM_RENDERER_FLAG));
        setTerminalFontSize(normalizeTerminalFontSize(settings[TERMINAL_FONT_SIZE_KEY]));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = readLotusSettingsChangedDetail(event);
      if (!detail) return;
      setFeatureEnabled(resolveFeatureFlag(detail.settings as ClaudeSettings, TERMINAL_RUNTIME_V2_FLAG));
      setPooledRendererEnabled(resolveFeatureFlag(detail.settings as ClaudeSettings, TERMINAL_V2_POOLED_DOM_RENDERER_FLAG));
      setTerminalFontSize(normalizeTerminalFontSize(detail.settings[TERMINAL_FONT_SIZE_KEY]));
    };

    window.addEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
  }, []);

  const hasActivationRequest = requested || activationRequested;
  const active = featureEnabled && hasActivationRequest;
  const runtime = useMemo(() => (
    active ? createTerminalV2Runtime() : null
  ), [active]);

  useEffect(() => {
    if (!runtime) return;
    return installTerminalV2LegacySessionAdapter(
      createLegacyTerminalSessionAdapter(runtime.sessionManager),
    );
  }, [runtime]);

  useEffect(() => {
    if (!runtime || typeof document === "undefined" || !isTauri()) return;

    const policyInput = resolveTerminalV2PooledRendererUiPolicyInput({
      featureEnabled: pooledRendererEnabled,
    });
    const policy = resolveTerminalV2PooledDomRendererPolicy(policyInput);
    if (!policy.enabled) return;

    let disposed = false;
    let disposeAdapter: (() => void) | null = null;
    // Built from the look at mount time only. A later theme or font-size change goes to the live
    // slots through `setAppearance` (effect below): tearing the slots down for it left every pane
    // bound to a disposed renderer, so the terminal went blank on a theme switch.
    const appearance = pooledAppearanceRef.current;
    void loadDefaultPooledXtermRendererFactory({
      fontSize: appearance.fontSize,
      terminalTheme: appearance.theme,
    }).then((createRenderer) => {
      if (disposed) return;
      const result = mountTerminalV2PooledRendererUiAdapter({
        runtime,
        hostContainer: document.body,
        resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
        createRenderer,
        writePaneInput: (paneId, data) => runtime.writePooledRendererInput(paneId, data),
        onFitGeometry: (paneId, cols, rows) => runtime.resizePaneSession(paneId, cols, rows),
        policyInput,
      });
      if (result.kind !== "enabled") return;
      disposeAdapter = result.dispose;
      pooledSlotFactoryRef.current = result.harness.slotFactory;
      // The look may have changed while the renderer bundle was loading.
      result.harness.slotFactory.setAppearance(pooledAppearanceRef.current);
    });

    return () => {
      disposed = true;
      pooledSlotFactoryRef.current = null;
      disposeAdapter?.();
    };
  }, [pooledRendererEnabled, runtime]);

  useEffect(() => {
    pooledAppearanceRef.current = { theme: terminalTheme, fontSize: terminalFontSize };
    pooledSlotFactoryRef.current?.setAppearance(pooledAppearanceRef.current);
  }, [terminalFontSize, terminalTheme]);

  useEffect(() => () => {
    runtime?.dispose();
  }, [runtime]);

  const value = useMemo<TerminalV2RuntimeContextValue>(() => ({
    featureEnabled,
    pooledRendererEnabled,
    activationRequested: hasActivationRequest,
    active,
    runtime,
    requestActivation,
  }), [active, featureEnabled, hasActivationRequest, pooledRendererEnabled, requestActivation, runtime]);

  return (
    <TerminalV2RuntimeContext.Provider value={value}>
      {children}
    </TerminalV2RuntimeContext.Provider>
  );
}

export function useOptionalTerminalV2Runtime(): TerminalV2RuntimeContextValue | null {
  return useContext(TerminalV2RuntimeContext);
}

export function useTerminalV2Runtime(): TerminalV2RuntimeContextValue {
  const context = useOptionalTerminalV2Runtime();
  if (!context) {
    throw new Error("useTerminalV2Runtime must be used within TerminalV2RuntimeProvider");
  }
  return context;
}
