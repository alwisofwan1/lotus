"use client";

import { useMemo } from "react";
import type { TerminalLinkContextMenuPayload } from "@/modules/codespace/services/terminal-addons";

export type TerminalV2LinkContextAdapter = {
  openContextMenu(payload: TerminalLinkContextMenuPayload, containerRect: DOMRect | null): void;
};

export type UseTerminalV2LinksOptions = {
  onLinkContextMenu?: (payload: TerminalLinkContextMenuPayload) => void;
};

export type UseTerminalV2LinksResult = {
  linkContextAdapter: TerminalV2LinkContextAdapter;
};

export function useTerminalV2Links({
  onLinkContextMenu,
}: UseTerminalV2LinksOptions): UseTerminalV2LinksResult {
  const linkContextAdapter = useMemo<TerminalV2LinkContextAdapter>(() => ({
    openContextMenu(payload, containerRect) {
      onLinkContextMenu?.({
        ...payload,
        clientX: containerRect ? payload.clientX - containerRect.left : payload.clientX,
        clientY: containerRect ? payload.clientY - containerRect.top : payload.clientY,
      });
    },
  }), [onLinkContextMenu]);

  return { linkContextAdapter };
}
