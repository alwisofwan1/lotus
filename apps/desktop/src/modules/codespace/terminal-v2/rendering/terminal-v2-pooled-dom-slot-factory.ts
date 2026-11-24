import {
  type TerminalV2PooledDomSlot,
  type TerminalV2PooledRenderer,
  type TerminalV2PooledRendererAppearance,
  createTerminalV2PooledDomSlot,
} from "./terminal-v2-pooled-dom-slot";
import {
  type TerminalV2PooledDomRendererPolicy,
  type TerminalV2PooledDomRendererPolicyInput,
  resolveTerminalV2PooledDomRendererPolicy,
} from "./terminal-v2-pooled-dom-renderer-policy";

export type TerminalV2PooledDomSlotFactoryOptions = {
  parkingContainer: HTMLElement;
  resolvePaneContainer(paneId: string): HTMLElement | null;
  createRenderer(slotElement: HTMLElement, slotId: string): TerminalV2PooledRenderer;
  writePaneInput?(paneId: string, data: string): void;
  onFitGeometry?(paneId: string, cols: number, rows: number): void;
  policyInput?: TerminalV2PooledDomRendererPolicyInput;
};

export type TerminalV2PooledDomSlotFactory = {
  readonly policy: TerminalV2PooledDomRendererPolicy;
  getSlot(slotId: string): TerminalV2PooledDomSlot | null;
  disposeSlot(slotId: string): void;
  /**
   * Applies a theme or font size to every slot, now and for slots created later. Changing the look
   * must never rebuild the slots: a rebuilt xterm starts empty, and the panes it served go blank.
   */
  setAppearance(appearance: TerminalV2PooledRendererAppearance): void;
  disposeAll(): void;
};

export function createTerminalV2PooledDomSlotFactory({
  parkingContainer,
  resolvePaneContainer,
  createRenderer,
  writePaneInput,
  onFitGeometry,
  policyInput = {},
}: TerminalV2PooledDomSlotFactoryOptions): TerminalV2PooledDomSlotFactory {
  const policy = resolveTerminalV2PooledDomRendererPolicy(policyInput);
  const slots = new Map<string, TerminalV2PooledDomSlot>();
  let appearance: TerminalV2PooledRendererAppearance | null = null;

  return {
    policy,
    getSlot(slotId) {
      if (!policy.enabled) return null;
      const existing = slots.get(slotId);
      if (existing) return existing;
      const next = createTerminalV2PooledDomSlot({
        slotId,
        parkingContainer,
        resolvePaneContainer,
        createRenderer,
        writePaneInput,
        onFitGeometry,
      });
      slots.set(slotId, next);
      if (appearance) next.setAppearance(appearance);
      return next;
    },
    disposeSlot(slotId) {
      const slot = slots.get(slotId);
      if (!slot) return;
      slots.delete(slotId);
      slot.dispose();
    },
    setAppearance(next) {
      appearance = { ...appearance, ...next };
      for (const slot of slots.values()) slot.setAppearance(next);
    },
    disposeAll() {
      for (const [slotId, slot] of slots) {
        slots.delete(slotId);
        slot.dispose();
      }
    },
  };
}
