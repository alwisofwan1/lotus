"use client";

import { CanvasAddProjectPanel } from "@/modules/codecanvas/components/panels/CanvasAddProjectPanel";
import type { SshTarget } from "@/modules/codespace/services/ssh-command";

/** The workspace name for a folder on another machine: `host:folder`, so it never reads as a local one. */
export function remoteWorkspaceLabel(host: string, root: string): string {
  const folder = root.replace(/\/+$/, "").split("/").pop() || root;
  return `${host}:${folder}`;
}

/**
 * Code's "folder on another machine": Canvas's own picker (machine list, Cloudflare Access sign-in,
 * remote folder browser), so both modes reach a machine one way. `.codecanvas-shell` carries the
 * `--canvas-*` tokens its CSS reads; without it every colour resolves to nothing.
 */
export function RemoteFolderPicker({
  onOpen,
  onClose,
}: {
  onOpen: (target: SshTarget, root: string, label: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="codecanvas-shell ws-remote-picker">
      <div
        className="canvas-picker-overlay"
        role="presentation"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <CanvasAddProjectPanel
          projects={[]}
          // This picker is only for other machines; a local folder is the wizard's own field.
          onPickLocalFolder={onClose}
          onOpenProject={(root, location) => {
            if (location?.kind !== "ssh") return;
            const target = { host: location.host, user: location.user ?? null, port: location.port ?? null };
            onOpen(target, root, remoteWorkspaceLabel(location.host, root));
          }}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
