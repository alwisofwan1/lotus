"use client";

import { ShieldQuestion } from "lucide-react";

interface WorkbenchTrustBannerProps {
  /** The language server that would start ("TypeScript", "rust-analyzer"). */
  serverLabel: string;
  folderName: string;
  onTrust: () => void;
  onDismiss: () => void;
}

/**
 * Over the editor the first time a file in an untrusted folder could use a language server.
 * A server runs the project's own tools (`node_modules/.bin`, build scripts), so it starts only
 * once the user says the folder is safe — the question VS Code's Workspace Trust asks.
 */
export function WorkbenchTrustBanner({ serverLabel, folderName, onTrust, onDismiss }: WorkbenchTrustBannerProps) {
  return (
    <div role="region" aria-label="Folder trust" className="codespace-conflict-banner">
      <ShieldQuestion className="h-3.5 w-3.5 shrink-0 text-[color:var(--codespace-panel-text-muted)]" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate" title={`${serverLabel} gives errors, hover and go to definition. It can run code from ${folderName}, such as its node_modules tools or build scripts. Trust only folders you know.`}>
        <span className="font-medium text-[color:var(--codespace-panel-text)]">Trust {folderName}?</span>
        {" "}{serverLabel} can run code from this folder to show errors and definitions.
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        <button type="button" className="codespace-conflict-action codespace-conflict-action--primary" onClick={onTrust}>
          Trust folder
        </button>
        <button type="button" className="codespace-conflict-action" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
