"use client";

import {
  isTauri,
  webviewBack,
  webviewCreate,
  webviewDestroy,
  webviewForward,
  webviewNavigate,
  webviewReload,
  webviewSetBounds,
  webviewSetVisible,
  type CodeSpaceWebviewBounds,
} from "@/lib/tauri-api";
import { closeEmbeddedBrowserPreview } from "@/lib/tauri/browser-preview";
import { isTauriCancelationError } from "@/lib/tauri/runtime";
import type { GridCell } from "@/modules/codespace/components/types";

type WebviewRegistryEntry = {
  url: string;
};

const REGISTRY = new Map<string, WebviewRegistryEntry>();

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildCodeSpaceWebviewLabel(...parts: string[]): string {
  const normalized = parts
    .map((part) => sanitizeSegment(part))
    .filter(Boolean)
    .join("-");
  return `codespace-pane-${normalized || "default"}`;
}

async function runWebviewOperation(operation: () => Promise<void>): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    if (isTauriCancelationError(error)) return false;
    throw error;
  }
}

export async function ensureWebviewPane(
  label: string,
  url: string,
  bounds: CodeSpaceWebviewBounds,
): Promise<void> {
  if (!isTauri()) return;

  const existing = REGISTRY.get(label);
  if (!existing) {
    const completed = await runWebviewOperation(() => webviewCreate(label, url, bounds));
    if (!completed) return;
    REGISTRY.set(label, { url });
    return;
  }

  if (existing.url !== url) {
    const completed = await runWebviewOperation(() => webviewNavigate(label, url));
    if (!completed) return;
    existing.url = url;
  }
}

export async function syncWebviewPaneBounds(label: string, bounds: CodeSpaceWebviewBounds): Promise<void> {
  if (!isTauri()) return;
  await runWebviewOperation(() => webviewSetBounds(label, bounds));
}

export async function setWebviewPaneVisible(label: string, visible: boolean): Promise<void> {
  if (!isTauri()) return;
  await runWebviewOperation(() => webviewSetVisible(label, visible));
}

export async function navigateWebviewPane(label: string, url: string): Promise<void> {
  if (!isTauri()) return;
  const completed = await runWebviewOperation(() => webviewNavigate(label, url));
  if (!completed) return;
  REGISTRY.set(label, { url });
}

export async function reloadWebviewPane(label: string): Promise<void> {
  if (!isTauri()) return;
  await runWebviewOperation(() => webviewReload(label));
}

export async function backWebviewPane(label: string): Promise<void> {
  if (!isTauri()) return;
  await runWebviewOperation(() => webviewBack(label));
}

export async function forwardWebviewPane(label: string): Promise<void> {
  if (!isTauri()) return;
  await runWebviewOperation(() => webviewForward(label));
}

export async function destroyWebviewPane(label: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await runWebviewOperation(() => webviewDestroy(label));
  } finally {
    REGISTRY.delete(label);
  }
}

/** The Chat Preview browser slot a Code Browser pane runs in: one per pane, pane ids are unique. */
export function codeBrowserSlot(paneId: string): string {
  return `code-${paneId}`;
}

function destroyWebviewPaneQuietly(label: string): void {
  void destroyWebviewPane(label).catch(() => {});
}

export function destroyCodeSpaceWorkspaceWebviews(
  workspaceId: string,
  cells: readonly GridCell[],
): void {
  for (const cell of cells) {
    if (cell.type === "browser") {
      destroyWebviewPaneQuietly(buildCodeSpaceWebviewLabel("grid", workspaceId, cell.id));
      void closeEmbeddedBrowserPreview(codeBrowserSlot(cell.id)).catch(() => {});
      continue;
    }

    if (cell.type !== "workbench") continue;
    for (const tab of cell.tabs) {
      if (tab.kind !== "url") continue;
      destroyWebviewPaneQuietly(buildCodeSpaceWebviewLabel("workbench", cell.id, tab.id));
    }
  }
}
