import { useEffect } from "react";
import type { TerminalLinkContextMenuPayload } from "@/modules/codespace/services/terminal-addons";
import type { TerminalShortcutEvent } from "@/modules/codespace/services/terminal-keybindings";
import {
  TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT,
  TERMINAL_V2_POOLED_LINK_CONTEXT_MENU_EVENT,
  type TerminalV2PooledCustomKeyDetail,
} from "@/modules/codespace/terminal-v2/rendering/terminal-v2-pooled-xterm-renderer-factory";

type TerminalV2PooledRendererEventsRef = {
  current: HTMLElement | null;
};

export type UseTerminalV2PooledRendererEventsOptions = {
  rootRef: TerminalV2PooledRendererEventsRef;
  onLinkContextMenu: (payload: TerminalLinkContextMenuPayload) => void;
  onTerminalCustomKey?: (event: TerminalShortcutEvent) => boolean | undefined;
};

export function useTerminalV2PooledRendererEvents({
  rootRef,
  onLinkContextMenu,
  onTerminalCustomKey,
}: UseTerminalV2PooledRendererEventsOptions): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handlePooledLinkContextMenu = (event: Event) => {
      const detail = (event as CustomEvent<TerminalLinkContextMenuPayload>).detail;
      if (!detail?.link) return;
      onLinkContextMenu(detail);
    };

    const handlePooledCustomKey = (event: Event) => {
      const detail = (event as CustomEvent<TerminalV2PooledCustomKeyDetail>).detail;
      if (!detail?.event) return;
      detail.result = onTerminalCustomKey?.(detail.event) ?? true;
    };

    root.addEventListener(TERMINAL_V2_POOLED_LINK_CONTEXT_MENU_EVENT, handlePooledLinkContextMenu);
    root.addEventListener(TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT, handlePooledCustomKey);
    return () => {
      root.removeEventListener(TERMINAL_V2_POOLED_LINK_CONTEXT_MENU_EVENT, handlePooledLinkContextMenu);
      root.removeEventListener(TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT, handlePooledCustomKey);
    };
  }, [onLinkContextMenu, onTerminalCustomKey, rootRef]);
}
