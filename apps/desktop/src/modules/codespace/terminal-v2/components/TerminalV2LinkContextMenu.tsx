import { Copy, ExternalLink, FileCode2 } from "lucide-react";
import { activateDetectedLink, type TerminalLinkContextMenuPayload } from "@/modules/codespace/services/terminal-addons";
import {
  FileTreeContextMenu,
  type FileTreeMenuCloseReason,
} from "@/modules/codespace/components/workbench/FileTreeContextMenu";

export type TerminalV2LinkContextMenuProps = {
  contextMenu: TerminalLinkContextMenuPayload | null;
  cwd: string;
  onClose: (reason: FileTreeMenuCloseReason) => void;
};

/** The menu a right-click on a terminal link opens, at the pointer (clamped to the window). */
export function TerminalV2LinkContextMenu({
  contextMenu,
  cwd,
  onClose,
}: TerminalV2LinkContextMenuProps) {
  if (!contextMenu) return null;
  const { link } = contextMenu;
  const external = link.kind === "external";

  return (
    <FileTreeContextMenu
      label={`Actions for ${link.text}`}
      x={contextMenu.clientX}
      y={contextMenu.clientY}
      onClose={onClose}
      items={[
        {
          id: "open",
          label: external ? "Open Link" : "Open File",
          icon: external ? ExternalLink : FileCode2,
          run: () => {
            activateDetectedLink(link, cwd).catch((error) => {
              console.warn("[terminal] Failed to open terminal link:", link.text, error);
            });
          },
        },
        {
          id: "copy",
          label: external ? "Copy Link" : "Copy Path",
          icon: Copy,
          run: () => {
            navigator.clipboard.writeText(external ? link.url : link.text).catch((error) => {
              console.warn("[terminal] Failed to copy terminal link:", link.text, error);
            });
          },
        },
      ]}
    />
  );
}
