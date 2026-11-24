"use client";

import { AlertTriangle } from "lucide-react";

interface WorkbenchConflictBannerProps {
  fileName: string;
  onCompare: () => void;
  onReload: () => void;
  onOverwrite: () => void;
}

/**
 * Over the editor when a save was refused because the file changed on disk. The edits stay in
 * the buffer until one of the three is picked; Compare comes first, as it loses nothing.
 */
export function WorkbenchConflictBanner({ fileName, onCompare, onReload, onOverwrite }: WorkbenchConflictBannerProps) {
  return (
    <div role="alert" className="codespace-conflict-banner">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-200/80" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium text-[color:var(--codespace-panel-text)]">{fileName} changed on disk</span>
        {" "}since you opened it. Your edits are kept until you choose.
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        <button type="button" className="codespace-conflict-action codespace-conflict-action--primary" onClick={onCompare}>
          Compare
        </button>
        <button type="button" className="codespace-conflict-action" onClick={onReload}>
          Reload from disk
        </button>
        <button type="button" className="codespace-conflict-action codespace-conflict-action--danger" onClick={onOverwrite}>
          Overwrite
        </button>
      </div>
    </div>
  );
}
