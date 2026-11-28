"use client";
import { useEffect, useRef } from "react";
import { focusedSurfaceOwnsChord } from "@/lib/hotkeys/platform-chords";
import { isCodeEditorKeyTarget, isEditableCanvasKeyTarget, isEditorWidgetOpen, isTerminalKeyTarget } from "../services/canvas-keyboard-guard";
import {
  createModifierOnlyHotkeyTracker,
  isCanvasHotkeyRecordingActive,
  isGlobalCanvasHotkeyCommand,
  modifierOnlyChordForEvent,
  normalizeChord,
  resolveHotkeyCommandFromChord,
  shouldDispatchCanvasHotkeyCommand,
  type CanvasHotkeyCommandId,
} from "../services/canvas-hotkeys";
import { getCanvasHotkeyOverrides } from "./useCanvasHotkeySettings";

export type CanvasHotkeyHandlers = Partial<Record<CanvasHotkeyCommandId, () => void>>;

/**
 * Single window-level dispatcher for canvas-layer hotkeys. Resolves ordinary chords on keydown and
 * standalone modifiers on keyup against the user's live overrides, applies the command-aware focus
 * gate, then invokes the matching handler. Commands without a handler are ignored.
 */
export function useCanvasHotkeys(handlers: CanvasHotkeyHandlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const modifierTracker = createModifierOnlyHotkeyTracker();
    const dispatchChord = (chord: string, event: KeyboardEvent) => {
      const command = resolveHotkeyCommandFromChord(chord, getCanvasHotkeyOverrides());
      if (!command) return;
      const handler = handlersRef.current[command];
      if (!handler) return;
      const codeEditor = isCodeEditorKeyTarget(event.target);
      const target = {
        editable: isEditableCanvasKeyTarget(event.target),
        terminal: isTerminalKeyTarget(event.target),
        codeEditor,
        editorWidgetOpen: codeEditor && isEditorWidgetOpen(),
        surfaceOwnsChord: focusedSurfaceOwnsChord(event),
      };
      if (!shouldDispatchCanvasHotkeyCommand(command, chord, target)) return;
      event.preventDefault();
      if (isGlobalCanvasHotkeyCommand(command)) event.stopPropagation();
      handler();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isCanvasHotkeyRecordingActive()) {
        modifierTracker.reset();
        return;
      }
      modifierTracker.keyDown(event);
      if (modifierOnlyChordForEvent(event)) return;
      dispatchChord(normalizeChord(event), event);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (isCanvasHotkeyRecordingActive()) {
        modifierTracker.reset();
        return;
      }
      const chord = modifierTracker.keyUp(event);
      if (chord) dispatchChord(chord, event);
    };
    const onBlur = () => modifierTracker.reset();
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      modifierTracker.reset();
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}
