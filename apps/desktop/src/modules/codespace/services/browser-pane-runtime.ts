"use client";

import type { CodeSpaceWebviewBounds } from "@/lib/tauri-api";
import {
  backWebviewPane,
  destroyWebviewPane,
  ensureWebviewPane,
  forwardWebviewPane,
  navigateWebviewPane,
  reloadWebviewPane,
  setWebviewPaneVisible,
  syncWebviewPaneBounds,
} from "@/modules/codespace/services/webview-registry";

export type BrowserPanePersistence = "destroy-on-unmount" | "keep-alive-hidden";

export type BrowserPaneNativeAdapter = {
  ensure(label: string, url: string, bounds: CodeSpaceWebviewBounds): Promise<void>;
  syncBounds(label: string, bounds: CodeSpaceWebviewBounds): Promise<void>;
  setVisible(label: string, visible: boolean): Promise<void>;
  navigate(label: string, url: string): Promise<void>;
  reload(label: string): Promise<void>;
  back(label: string): Promise<void>;
  forward(label: string): Promise<void>;
  destroy(label: string): Promise<void>;
};

export type BrowserPaneHostSnapshot = {
  label: string;
  url: string;
  enabled: boolean;
  visible: boolean;
  bounds: CodeSpaceWebviewBounds;
};

export type BrowserPaneRuntimeSyncInput = {
  adapter?: BrowserPaneNativeAdapter;
  label: string;
  url: string;
  enabled: boolean;
  host: HTMLElement;
};

export type BrowserPaneRuntimeDisposeInput = {
  adapter?: BrowserPaneNativeAdapter;
  label: string;
  persistence: BrowserPanePersistence;
};

export const HIDDEN_BROWSER_PANE_BOUNDS: CodeSpaceWebviewBounds = {
  x: -10000,
  y: -10000,
  width: 1,
  height: 1,
};

export const nativeBrowserPaneAdapter: BrowserPaneNativeAdapter = {
  ensure: ensureWebviewPane,
  syncBounds: syncWebviewPaneBounds,
  setVisible: setWebviewPaneVisible,
  navigate: navigateWebviewPane,
  reload: reloadWebviewPane,
  back: backWebviewPane,
  forward: forwardWebviewPane,
  destroy: destroyWebviewPane,
};

export function normalizeBrowserPaneUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("localhost") || trimmed.startsWith("127.0.0.1")) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

export function readBrowserPaneHostBounds(host: HTMLElement): CodeSpaceWebviewBounds {
  const rect = host.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function isBrowserPaneHostVisible(host: HTMLElement): boolean {
  const rect = host.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false;
  if (host.offsetParent === null && getComputedStyle(host).position !== "fixed") return false;
  const style = getComputedStyle(host);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

export function snapshotBrowserPaneHost(input: BrowserPaneRuntimeSyncInput): BrowserPaneHostSnapshot {
  const enabled = input.enabled && input.url.trim().length > 0;
  const visible = enabled && isBrowserPaneHostVisible(input.host);
  return {
    label: input.label,
    url: input.url,
    enabled,
    visible,
    bounds: visible ? readBrowserPaneHostBounds(input.host) : HIDDEN_BROWSER_PANE_BOUNDS,
  };
}

export async function syncBrowserPaneRuntime(input: BrowserPaneRuntimeSyncInput): Promise<BrowserPaneHostSnapshot> {
  const adapter = input.adapter ?? nativeBrowserPaneAdapter;
  const snapshot = snapshotBrowserPaneHost(input);

  if (!snapshot.enabled) {
    await adapter.syncBounds(snapshot.label, HIDDEN_BROWSER_PANE_BOUNDS);
    await adapter.setVisible(snapshot.label, false);
    return snapshot;
  }

  await adapter.ensure(snapshot.label, snapshot.url, snapshot.bounds);
  await adapter.syncBounds(snapshot.label, snapshot.bounds);
  await adapter.setVisible(snapshot.label, snapshot.visible);
  return snapshot;
}

export async function disposeBrowserPaneRuntime(input: BrowserPaneRuntimeDisposeInput): Promise<void> {
  const adapter = input.adapter ?? nativeBrowserPaneAdapter;

  if (input.persistence === "destroy-on-unmount") {
    await adapter.destroy(input.label);
    return;
  }

  await adapter.syncBounds(input.label, HIDDEN_BROWSER_PANE_BOUNDS);
  await adapter.setVisible(input.label, false);
}
