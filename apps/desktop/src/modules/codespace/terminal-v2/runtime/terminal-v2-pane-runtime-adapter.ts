import {
  TerminalPaneRuntime,
  type TerminalPaneHost,
  type TerminalPaneSnapshot,
} from "@/modules/codespace/services/terminal-pane-runtime";

export type TerminalV2PaneRuntimeHost = TerminalPaneHost;
export type TerminalV2PaneRuntimeSnapshot = TerminalPaneSnapshot;

export type TerminalV2PaneRuntimePort = {
  getSnapshot(): TerminalV2PaneRuntimeSnapshot;
  isLiveResizing(): boolean;
  init(): void;
  notifyXtermCreated(): void;
  notifyAttached(): void;
  setVisible(visible: boolean): void;
  notifyRendererPromoting(): void;
  notifyRendererPromoted(): void;
  notifyRendererPromotionFailed(): void;
  notifyRendererDemoted(): void;
  notifyRendererLost(): void;
  notifyLiveResizeStart(): void;
  notifyLiveResizeEnd(): void;
  dispose(): void;
};

export type TerminalV2PaneRuntimeAdapterOptions = {
  host: TerminalV2PaneRuntimeHost;
  initiallyVisible: boolean;
};

export type TerminalV2PaneRuntimeFactory = (
  options: TerminalV2PaneRuntimeAdapterOptions,
) => TerminalV2PaneRuntimePort;

export function createTerminalV2PaneRuntimeAdapter({
  host,
  initiallyVisible,
}: TerminalV2PaneRuntimeAdapterOptions): TerminalV2PaneRuntimePort {
  return new TerminalPaneRuntime(host, { initiallyVisible });
}
