import type {
  TerminalV2FitAddonLike,
  TerminalV2XtermLike,
  TerminalV2XtermRendererSlot,
} from "./terminal-v2-xterm-renderer-host";

export type TerminalV2LegacyXtermSlotOptions = {
  paneId: string;
  terminal: TerminalV2XtermLike;
  fitAddon: TerminalV2FitAddonLike;
  onAttach?: (paneId: string) => void;
  onRelease?: (paneId: string, snapshot: string | null) => void;
};

export function createTerminalV2LegacyXtermSlot({
  paneId,
  terminal,
  fitAddon,
  onAttach,
  onRelease,
}: TerminalV2LegacyXtermSlotOptions): TerminalV2XtermRendererSlot {
  return {
    terminal,
    fitAddon,
    liveOutputMode: "external",
    attachPane(nextPaneId) {
      onAttach?.(nextPaneId);
    },
    releasePane(nextPaneId, snapshot) {
      onRelease?.(nextPaneId || paneId, snapshot);
    },
    focus: () => {
      terminal.focus?.();
      return Boolean(terminal.focus);
    },
    blur: () => {
      terminal.blur?.();
      return Boolean(terminal.blur);
    },
  };
}
