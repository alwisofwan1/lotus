"use client";
import type { SaveState } from "../hooks/useSettingsFile";

/** The quiet "Saved" sign of an instantly-saving section, and its error when a write fails. */
export function SaveStatus({ state }: { state: SaveState }) {
  if (state.kind === "error") {
    return (
      <p role="alert" className="ds-t-meta leading-relaxed text-red-400" style={{ margin: 0 }}>
        {state.message}
      </p>
    );
  }
  return (
    <p role="status" aria-live="polite" className="ds-t-meta h-4 text-(--text-muted)" style={{ margin: 0 }}>
      {state.kind === "saving" ? "Saving…" : state.kind === "saved" ? "Saved" : ""}
    </p>
  );
}
