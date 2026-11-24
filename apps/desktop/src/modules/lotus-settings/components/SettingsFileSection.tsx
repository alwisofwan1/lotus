"use client";
import { useCallback, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import type { ClaudeSettings } from "@/modules/settings/types";
import { useSettingsFile } from "../hooks/useSettingsFile";
import { SaveStatus } from "./SaveStatus";

type Update = (patch: Partial<ClaudeSettings>) => void;

function isTextField(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return !["checkbox", "radio", "range", "button", "submit", "color", "file"].includes(element.type);
}

/**
 * Hosts a section written against `{settings, update}` — the props the retired Settings page passed — and
 * makes it save instantly through `useSettingsFile`, with the "Saved" sign above it.
 *
 * Text fields in those sections call `update` per keystroke. While one has focus its changes are
 * held, and written when it loses focus or on Enter, so a half-typed command is never saved and no
 * section has to be rewritten field by field.
 */
export function SettingsFileSection({ children }: { children: (settings: ClaudeSettings, update: Update) => ReactNode }) {
  const { settings, update, commit, state } = useSettingsFile();
  // State, not a ref: `guardedUpdate` is handed to render, and a callback ref keeps it current.
  const [sectionRoot, setSectionRoot] = useState<HTMLDivElement | null>(null);

  const guardedUpdate = useCallback<Update>((patch) => {
    const active = document.activeElement;
    update(patch, { hold: isTextField(active) && !!sectionRoot?.contains(active) });
  }, [update, sectionRoot]);

  const onBlur = (event: FocusEvent) => { if (isTextField(event.target)) commit(); };
  const onKeyDown = (event: KeyboardEvent) => {
    // Not mid-IME: that Enter picks a candidate, it does not finish the value.
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (event.target instanceof HTMLInputElement && isTextField(event.target)) commit();
  };

  return (
    // The status floats in the gap above the section, so an idle one reserves no blank line.
    <div className="relative flex flex-col">
      {state.kind === "error" ? (
        <div className="pb-2">
          <SaveStatus state={state} />
        </div>
      ) : (
        <div className="absolute -top-5 right-0">
          <SaveStatus state={state} />
        </div>
      )}
      {settings ? (
        <div ref={setSectionRoot} onBlur={onBlur} onKeyDown={onKeyDown}>
          {children(settings, guardedUpdate)}
        </div>
      ) : null}
    </div>
  );
}
