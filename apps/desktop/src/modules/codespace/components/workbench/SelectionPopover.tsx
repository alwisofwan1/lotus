"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { Copy, MessageSquareText, SendHorizontal } from "lucide-react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { selectedLineRange } from "@/modules/codespace/services/selection-payload";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

/*
 * The three things a selection in the Editor (or the diff) can be handed to — ⌘L's popover.
 *
 * Shown once a selection settles: after the mouse is released, or after a keyboard selection.
 * Hidden by Esc, by an empty selection, and when the editor loses focus. The buttons keep the
 * editor focused (`mousedown` is prevented), so pressing one does not first hide it.
 */

export type SelectionAction = "send" | "ask" | "copy";

export interface EditorLineSelection {
  startLine: number;
  endLine: number;
  /** The whole lines, as the model has them. */
  code: string;
}

/** The selected whole lines; the cursor's line when nothing is selected (⌘L on a bare cursor). */
export function readLineSelection(editorInstance: MonacoEditorNS.ICodeEditor): EditorLineSelection | null {
  const model = editorInstance.getModel();
  const selection = editorInstance.getSelection();
  if (!model || !selection) return null;
  const { startLine, endLine } = selectedLineRange(selection);
  const code = model.getValueInRange({
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: model.getLineMaxColumn(endLine),
  });
  return { startLine, endLine, code };
}

/** ⌘L (Ctrl+L elsewhere). Empty when the Monaco namespace is not the real one (tests). */
export function sendSelectionKeybinding(monacoApi: Pick<typeof import("monaco-editor"), "KeyMod" | "KeyCode"> | undefined): number[] {
  if (!monacoApi?.KeyMod || !monacoApi?.KeyCode) return [];
  return [monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyL];
}

type PopoverPosition = { top: number; left: number };

const POPOVER_WIDTH = 300;
const SHOW_DELAY_MS = 120;

/**
 * Where the popover goes: just below the end of the selection, inside `container`. Null when that
 * point is scrolled out of view.
 */
function popoverPosition(
  editorInstance: MonacoEditorNS.ICodeEditor,
  container: HTMLElement,
): PopoverPosition | null {
  const selection = editorInstance.getSelection();
  const editorNode = editorInstance.getDomNode();
  if (!selection || selection.isEmpty() || !editorNode) return null;
  const visible = editorInstance.getScrolledVisiblePosition(selection.getPosition());
  if (!visible) return null;
  const editorRect = editorNode.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const top = editorRect.top - containerRect.top + visible.top + visible.height + 4;
  if (top < 0 || top > containerRect.height - 28) return null;
  const left = editorRect.left - containerRect.left + visible.left;
  return { top, left: Math.max(8, Math.min(left, containerRect.width - POPOVER_WIDTH - 8)) };
}

/** Tracks one editor's selection and says where its popover belongs, or null for hidden. */
export function useSelectionPopover(
  editorInstance: MonacoEditorNS.ICodeEditor | null,
  containerRef: RefObject<HTMLElement | null>,
): { position: PopoverPosition | null; hide: () => void } {
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const hide = useCallback(() => setPosition(null), []);

  useEffect(() => {
    if (!editorInstance) return;
    let timer: number | null = null;
    let mouseDown = false;
    let shown = false;
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const place = () => {
      const container = containerRef.current;
      const next = container ? popoverPosition(editorInstance, container) : null;
      shown = next !== null;
      setPosition(next);
    };
    const showSoon = () => {
      clearTimer();
      timer = window.setTimeout(place, SHOW_DELAY_MS);
    };
    const hideNow = () => {
      clearTimer();
      shown = false;
      setPosition(null);
    };

    const disposables = [
      editorInstance.onMouseDown(() => {
        mouseDown = true;
        hideNow();
      }),
      editorInstance.onMouseUp(() => {
        mouseDown = false;
        if (!editorInstance.getSelection()?.isEmpty()) showSoon();
      }),
      editorInstance.onDidChangeCursorSelection((event) => {
        if (event.selection.isEmpty()) {
          hideNow();
          return;
        }
        // A drag is still going: wait for the mouse to come up.
        if (!mouseDown && event.source === "keyboard") showSoon();
      }),
      editorInstance.onDidScrollChange(() => {
        if (shown) place();
      }),
      editorInstance.onKeyDown((event) => {
        if (event.browserEvent.key === "Escape") hideNow();
      }),
      editorInstance.onDidBlurEditorText(hideNow),
      editorInstance.onDidChangeModel(hideNow),
    ];
    return () => {
      clearTimer();
      for (const disposable of disposables) disposable.dispose();
      setPosition(null);
    };
  }, [containerRef, editorInstance]);

  return { position, hide };
}

export function SelectionPopover({
  position,
  lineLabel,
  onAction,
}: {
  position: PopoverPosition;
  /** `path:N-M`, the Copy button's text. */
  lineLabel: string;
  onAction: (action: SelectionAction) => void;
}) {
  const shortcut = useFormatShortcut();
  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="codespace-selection-popover"
      style={{ top: position.top, left: position.left }}
      // Keep the editor focused: a blur would hide the popover before the click lands.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" onClick={() => onAction("send")} title="Put the selection in a Thread's composer">
        <SendHorizontal className="h-3 w-3" aria-hidden="true" />
        Send to Thread
        <kbd>{shortcut("⌘L")}</kbd>
      </button>
      <button type="button" onClick={() => onAction("ask")} title="Send with “Explain these lines”">
        <MessageSquareText className="h-3 w-3" aria-hidden="true" />
        Ask about this
      </button>
      <button type="button" onClick={() => onAction("copy")} title={`Copy ${lineLabel}`}>
        <Copy className="h-3 w-3" aria-hidden="true" />
        Copy path
      </button>
    </div>
  );
}
