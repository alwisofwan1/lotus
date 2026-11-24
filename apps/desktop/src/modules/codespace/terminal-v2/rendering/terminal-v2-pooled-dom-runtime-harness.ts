import type { TerminalV2PooledDomRendererPolicyInput } from "./terminal-v2-pooled-dom-renderer-policy";
import {
  type TerminalV2PooledDomSlotFactory,
  createTerminalV2PooledDomSlotFactory,
} from "./terminal-v2-pooled-dom-slot-factory";
import type { TerminalV2PooledRenderer } from "./terminal-v2-pooled-dom-slot";

export type TerminalV2PooledDomRuntimeHarnessOptions = {
  hostContainer: HTMLElement;
  resolvePaneContainer(paneId: string): HTMLElement | null;
  createRenderer(slotElement: HTMLElement, slotId: string): TerminalV2PooledRenderer;
  writePaneInput?(paneId: string, data: string): void;
  onFitGeometry?(paneId: string, cols: number, rows: number): void;
  policyInput?: TerminalV2PooledDomRendererPolicyInput;
};

export type TerminalV2PooledDomRuntimeHarness = {
  parkingContainer: HTMLElement;
  slotFactory: TerminalV2PooledDomSlotFactory;
  dispose(): void;
};

export function createTerminalV2PooledDomRuntimeHarness({
  hostContainer,
  resolvePaneContainer,
  createRenderer,
  writePaneInput,
  onFitGeometry,
  policyInput = {},
}: TerminalV2PooledDomRuntimeHarnessOptions): TerminalV2PooledDomRuntimeHarness | null {
  const parkingContainer = hostContainer.ownerDocument.createElement("div");
  const slotFactory = createTerminalV2PooledDomSlotFactory({
    parkingContainer,
    resolvePaneContainer,
    createRenderer,
    writePaneInput,
    onFitGeometry,
    policyInput,
  });

  if (!slotFactory.policy.enabled) return null;

  parkingContainer.className = "terminal-v2-pooled-renderer-parking";
  parkingContainer.dataset.terminalV2PooledRendererParking = "true";
  parkingContainer.hidden = true;
  hostContainer.appendChild(parkingContainer);

  return {
    parkingContainer,
    slotFactory,
    dispose() {
      slotFactory.disposeAll();
      parkingContainer.remove();
    },
  };
}
