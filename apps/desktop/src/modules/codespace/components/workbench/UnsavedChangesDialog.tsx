"use client";

import { useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";

interface UnsavedChangesDialogProps {
  /** Absolute paths of the files with unsaved edits. */
  paths: readonly string[];
  rootDir: string;
  busy?: boolean;
  error?: string | null;
  /** `pane` covers the Editor pane it belongs to; `window` covers the whole app. */
  scope?: "pane" | "window";
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

function relativeTo(rootDir: string, path: string): string {
  const root = rootDir.replace(/[\\/]+$/, "");
  return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`) ? path.slice(root.length + 1) : path;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function UnsavedChangesDialog({
  paths,
  rootDir,
  busy = false,
  error = null,
  scope = "pane",
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  const titleId = useId();
  const saveRef = useRef<HTMLButtonElement>(null);
  const single = paths.length === 1;
  const title = single ? `Save changes to ${fileName(paths[0])}?` : `Save changes to ${paths.length} files?`;

  useEffect(() => {
    saveRef.current?.focus();
  }, []);

  const buttonClass =
    "rounded-[6px] border px-2.5 py-1 text-[11.5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[color:var(--codespace-panel-accent)]";

  return (
    <div
      className={cn(
        "z-50 grid place-items-center bg-black/45 p-4",
        scope === "pane" ? "absolute inset-0" : "fixed inset-0",
      )}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          if (!busy) onCancel();
        }}
        className="flex w-full max-w-[380px] flex-col gap-3 rounded-[10px] border border-[color:var(--codespace-panel-border)] bg-[color:var(--codespace-panel-surface-raised)] p-4 text-[color:var(--codespace-panel-text)] shadow-2xl"
      >
        <p id={titleId} className="text-[13px] font-semibold">{title}</p>
        <p className="text-[12px] leading-relaxed text-[color:var(--codespace-panel-text-muted)]">
          {single
            ? "Your edits are lost if you close without saving."
            : "Edits in these files are lost if you close without saving."}
        </p>
        {!single ? (
          <ul className="max-h-32 overflow-auto font-mono text-[11.5px] text-[color:var(--codespace-panel-text-muted)]">
            {paths.map((path) => <li key={path} className="truncate">{relativeTo(rootDir, path)}</li>)}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-[6px] bg-amber-300/10 px-2 py-1.5 text-[11.5px] text-amber-200">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onDiscard();
            }}
            className={cn(buttonClass, "border-[color:var(--codespace-panel-border)] hover:bg-white/[0.04]")}
          >
            Don&apos;t save
          </button>
          <span className="flex-1" />
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onCancel();
            }}
            className={cn(buttonClass, "border-[color:var(--codespace-panel-border)] hover:bg-white/[0.04]")}
          >
            Cancel
          </button>
          <button
            ref={saveRef}
            type="button"
            aria-busy={busy}
            onClick={() => {
              if (!busy) onSave();
            }}
            className={cn(buttonClass, "border-transparent bg-[color:var(--codespace-panel-accent,#4c8dff)] font-semibold text-white")}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
