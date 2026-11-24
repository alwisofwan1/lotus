"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauriCancelationError } from "@/lib/tauri/runtime";
import { useSurfaceVisible } from "@/lib/surface-visible";
import {
  disposeBrowserPaneRuntime,
  nativeBrowserPaneAdapter,
  syncBrowserPaneRuntime,
  type BrowserPaneNativeAdapter,
  type BrowserPanePersistence,
} from "@/modules/codespace/services/browser-pane-runtime";

export type UseBrowserPaneRuntimeOptions = {
  label: string;
  url: string;
  enabled?: boolean;
  persistence?: BrowserPanePersistence;
  adapter?: BrowserPaneNativeAdapter;
};

function reportBrowserPaneError(message: string, error: unknown) {
  if (isTauriCancelationError(error)) return;
  console.warn(message, error);
}

export function useBrowserPaneRuntime({
  label,
  url,
  enabled: asked = true,
  persistence = "destroy-on-unmount",
  adapter = nativeBrowserPaneAdapter,
}: UseBrowserPaneRuntimeOptions) {
  const surfaceVisible = useSurfaceVisible();
  const enabled = asked && surfaceVisible;
  const [hostNode, setHostNode] = useState<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setHostNode(node);
  }, []);

  useEffect(() => {
    const host = hostNode;
    if (!host) return;
    disposedRef.current = false;

    const runSync = () => {
      if (disposedRef.current) return;
      void syncBrowserPaneRuntime({ adapter, label, url, enabled, host }).catch((error: unknown) => {
        reportBrowserPaneError("[codespace] failed to sync browser pane:", error);
      });
    };

    const scheduleSync = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        runSync();
      });
    };

    runSync();

    const resizeObserver = new ResizeObserver(scheduleSync);
    const intersectionObserver = new IntersectionObserver(scheduleSync);
    resizeObserver.observe(host);
    intersectionObserver.observe(host);
    window.addEventListener("scroll", scheduleSync, true);
    window.addEventListener("resize", scheduleSync);

    return () => {
      disposedRef.current = true;
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener("scroll", scheduleSync, true);
      window.removeEventListener("resize", scheduleSync);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }

      void disposeBrowserPaneRuntime({ adapter, label, persistence }).catch((error: unknown) => {
        reportBrowserPaneError("[codespace] failed to dispose browser pane:", error);
      });
    };
  }, [adapter, enabled, hostNode, label, persistence, url]);

  const navigate = useCallback(async (nextUrl: string) => {
    await adapter.navigate(label, nextUrl).catch(() => {});
  }, [adapter, label]);

  const reload = useCallback(async () => {
    await adapter.reload(label).catch(() => {});
  }, [adapter, label]);

  const back = useCallback(async () => {
    await adapter.back(label).catch(() => {});
  }, [adapter, label]);

  const forward = useCallback(async () => {
    await adapter.forward(label).catch(() => {});
  }, [adapter, label]);

  return {
    containerRef,
    navigate,
    reload,
    back,
    forward,
  };
}
