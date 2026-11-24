"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import { cancelTerminalFileDropUpload, inspectTerminalFileDropPaths, uploadTerminalFileDropSshBatch } from "@/lib/tauri/terminal-file-drop";
import { writeTerminalSession, type TerminalRuntimeStatus } from "../services/terminal-session-registry";
import { listenWebviewDragDrop, safeTauriUnlisten, type TauriUnlisten } from "@/lib/tauri-listener-cleanup";
import {
  assembleDroppedPathPrompt,
  classifyDropInspection,
  dragDropHitTestPoints,
  inspectNativeDropPath,
  quoteModeForPlatform,
  sshUploadPolicy,
  type InspectedDropPath,
} from "../services/terminal-file-drop";
import type { TerminalFileDropOverlayState } from "../components/TerminalFileDropOverlay";

type TerminalDropCell = { id: string; type: string; cwd: string; runtimeStatus?: TerminalRuntimeStatus };

type NativeDropPosition = { x: number; y: number };

type DropTarget = {
  cellId: string;
  cwd: string;
  status: TerminalRuntimeStatus;
  location: "local" | "ssh";
};

export function useTerminalFileDrop({
  active,
  cells,
  location,
  onFocusCell,
}: {
  active: boolean;
  cells: TerminalDropCell[];
  location?: CodeSpaceStoredWorkspaceLocation | null;
  onFocusCell: (cellId: string) => void;
}) {
  const [overlay, setOverlay] = useState<TerminalFileDropOverlayState | null>(null);
  const scaleRef = useRef<number | null>(null);
  const queueRef = useRef(new Map<string, string>());
  const uploadJobRef = useRef<string | null>(null);
  const cellsById = useMemo(() => new Map(cells.map((cell) => [cell.id, cell])), [cells]);

  const dismissOverlay = useCallback(() => setOverlay(null), []);
  const notice = useCallback((message: string, tone: "success" | "error" = "error") => {
    setOverlay({ kind: "notice", message, tone });
    window.setTimeout(() => setOverlay((current) => current?.kind === "notice" ? null : current), 3600);
  }, []);

  const scaleFactor = useCallback(async () => {
    if (scaleRef.current !== null) return scaleRef.current;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    scaleRef.current = await getCurrentWindow().scaleFactor().catch(() => window.devicePixelRatio || 1);
    return scaleRef.current;
  }, []);

  const targetFromElement = useCallback((el: HTMLElement | null): DropTarget | null => {
    if (!el) return null;
    const cellId = el.dataset.terminalFileDropCellId;
    if (!cellId || !cellsById.has(cellId)) return null;
    return {
      cellId,
      cwd: el.dataset.terminalFileDropCwd || cellsById.get(cellId)?.cwd || "",
      status: (el.dataset.terminalFileDropStatus || cellsById.get(cellId)?.runtimeStatus || "idle") as TerminalRuntimeStatus,
      location: el.dataset.terminalFileDropLocation === "ssh" ? "ssh" : "local",
    };
  }, [cellsById]);

  const targetFromPosition = useCallback(async (position: NativeDropPosition): Promise<DropTarget | null> => {
    const scale = await scaleFactor();
    for (const point of dragDropHitTestPoints(position, scale)) {
      const el = document.elementFromPoint(point.x, point.y)?.closest("[data-terminal-file-drop-target='true']") as HTMLElement | null;
      const target = targetFromElement(el);
      if (target) return target;
    }
    return null;
  }, [scaleFactor, targetFromElement]);

  const inspectPaths = useCallback(async (paths: string[]): Promise<InspectedDropPath[]> => {
    const inspected = await inspectTerminalFileDropPaths(paths);
    return inspected.map((entry) => inspectNativeDropPath(entry.path, entry));
  }, []);

  const appendWhenReady = useCallback((target: DropTarget, prompt: string) => {
    onFocusCell(target.cellId);
    if (target.status === "live") {
      writeTerminalSession(target.cellId, prompt);
      return;
    }
    if (target.status === "starting") {
      queueRef.current.set(target.cellId, `${queueRef.current.get(target.cellId) ?? ""}${prompt}`);
      notice("Terminal is starting — file paths will be inserted when it is ready.", "success");
      return;
    }
    notice("Terminal is not ready for file drops.");
  }, [notice, onFocusCell]);

  const uploadSsh = useCallback(async (target: DropTarget, accepted: InspectedDropPath[]) => {
    if (location?.kind !== "ssh") return notice("SSH workspace information is missing.");
    const totalBytes = accepted.reduce((sum, file) => sum + file.size, 0);
    const policy = sshUploadPolicy(totalBytes);
    if (policy.kind === "reject") return notice(policy.reason);
    if (policy.kind === "confirm" && !window.confirm(`Upload ${accepted.length} file(s) (${Math.round(totalBytes / 1024 / 1024)} MB) to ${target.cwd}?`)) return;

    const jobId = crypto.randomUUID();
    uploadJobRef.current = jobId;
    setOverlay({ kind: "uploading", cellId: target.cellId, count: accepted.length, onCancel: () => { void cancelTerminalFileDropUpload(jobId); } });
    try {
      const result = await uploadTerminalFileDropSshBatch({ jobId, target: location, remoteCwd: target.cwd, files: accepted });
      const paths = result.uploaded.map((file) => file.remotePath);
      if (paths.length > 0) appendWhenReady(target, assembleDroppedPathPrompt(paths, "posix"));
      const failed = result.failed.length;
      notice(
        failed ? `Uploaded ${paths.length} file(s); ${failed} failed.` : `Uploaded ${paths.length} file(s) to ${target.cwd}`,
        failed ? "error" : "success",
      );
      window.dispatchEvent(new CustomEvent("terminal-file-drop:completed", { detail: { paneId: target.cellId, cwd: target.cwd, paths } }));
    } catch (error) {
      notice(error instanceof Error ? error.message : "File upload failed.");
    } finally {
      uploadJobRef.current = null;
    }
  }, [appendWhenReady, location, notice]);

  const handleDrop = useCallback(async (position: NativeDropPosition, paths: string[]) => {
    const target = await targetFromPosition(position);
    if (!target || paths.length === 0) return setOverlay(null);
    const inspected = classifyDropInspection(await inspectPaths(paths));
    if (inspected.rejected.length > 0 && inspected.accepted.length === 0) return notice(inspected.rejected[0].reason);
    if (inspected.accepted.length === 0) return;
    if (target.location === "ssh") {
      await uploadSsh(target, inspected.accepted);
      return;
    }
    appendWhenReady(target, assembleDroppedPathPrompt(inspected.accepted.map((file) => file.path), quoteModeForPlatform()));
    setOverlay(null);
  }, [appendWhenReady, inspectPaths, notice, targetFromPosition, uploadSsh]);

  useEffect(() => {
    for (const [cellId, prompt] of queueRef.current) {
      if (cellsById.get(cellId)?.runtimeStatus !== "live") continue;
      writeTerminalSession(cellId, prompt);
      queueRef.current.delete(cellId);
    }
  }, [cellsById]);

  useEffect(() => {
    if (!active || !isTauri()) return;
    let unlisten: TauriUnlisten | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const un = await listenWebviewDragDrop(getCurrentWebview(), async (event) => {
          if (event.payload.type === "leave") return setOverlay(null);
          if (event.payload.type === "enter" || event.payload.type === "over") {
            const target = await targetFromPosition(event.payload.position);
            return setOverlay(target ? { kind: "hover", cellId: target.cellId, mode: target.location, cwd: target.cwd } : null);
          }
          if (event.payload.type === "drop") await handleDrop(event.payload.position, event.payload.paths ?? []);
        });
        if (cancelled) safeTauriUnlisten(un); else unlisten = un;
      } catch {
        // Native drag-drop is opportunistic. Registration/unregistration can race
        // while workspaces remount; the terminal must stay usable without it.
      }
    })();
    return () => {
      cancelled = true;
      safeTauriUnlisten(unlisten);
      unlisten = undefined;
    };
  }, [active, handleDrop, targetFromPosition]);

  return { overlay, dismissOverlay };
}
