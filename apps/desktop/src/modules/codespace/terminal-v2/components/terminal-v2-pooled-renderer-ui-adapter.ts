import type { TerminalV2PooledDomRendererPolicyInput } from "../rendering/terminal-v2-pooled-dom-renderer-policy";
import {
  TERMINAL_V2_POOLED_DOM_RENDERER_STORAGE_KEY,
  resolveTerminalV2PooledDomRendererPolicy,
} from "../rendering/terminal-v2-pooled-dom-renderer-policy";
import type { TerminalV2PooledDomSlotFactory } from "../rendering/terminal-v2-pooled-dom-slot-factory";
import type { TerminalV2PooledRenderer } from "../rendering/terminal-v2-pooled-dom-slot";
import {
  createTerminalV2PooledDomRuntimeHarness,
  type TerminalV2PooledDomRuntimeHarness,
} from "../rendering/terminal-v2-pooled-dom-runtime-harness";

export type TerminalV2PooledRendererUiRuntime = {
  installPooledDomSlotFactory(factory: TerminalV2PooledDomSlotFactory): () => void;
};

export type TerminalV2PooledRendererUiAdapterOptions = {
  runtime: TerminalV2PooledRendererUiRuntime | null | undefined;
  hostContainer: HTMLElement | null | undefined;
  resolvePaneContainer(paneId: string): HTMLElement | null;
  createRenderer(slotElement: HTMLElement, slotId: string): TerminalV2PooledRenderer;
  writePaneInput?(paneId: string, data: string): void;
  onFitGeometry?(paneId: string, cols: number, rows: number): void;
  policyInput?: TerminalV2PooledDomRendererPolicyInput;
  storage?: Pick<Storage, "getItem"> | null;
};

type TerminalV2PooledRendererUiDisabledReason = "missing-runtime" | "missing-host" | "not-enabled" | "production" | "disabled-by-flag";

export type TerminalV2PooledRendererUiAdapterResult =
  | { kind: "disabled"; reason: TerminalV2PooledRendererUiDisabledReason }
  | { kind: "enabled"; harness: TerminalV2PooledDomRuntimeHarness; dispose(): void };

function toDisabledPolicyReason(reason: "enabled" | "not-enabled" | "production" | "disabled-by-flag"): TerminalV2PooledRendererUiDisabledReason {
  if (reason === "production") return "production";
  if (reason === "disabled-by-flag") return "disabled-by-flag";
  return "not-enabled";
}

export function resolveTerminalV2PooledRendererUiPolicyInput({
  environment = process.env.NODE_ENV,
  storage = globalThis.localStorage,
  featureEnabled,
}: {
  environment?: string;
  storage?: Pick<Storage, "getItem"> | null;
  featureEnabled?: boolean;
} = {}): TerminalV2PooledDomRendererPolicyInput {
  const input: TerminalV2PooledDomRendererPolicyInput = {
    environment,
    storageValue: storage?.getItem(TERMINAL_V2_POOLED_DOM_RENDERER_STORAGE_KEY) ?? null,
  };
  if (typeof featureEnabled === "boolean") {
    input.featureEnabled = featureEnabled;
  }
  return input;
}

export function mountTerminalV2PooledRendererUiAdapter({
  runtime,
  hostContainer,
  resolvePaneContainer,
  createRenderer,
  writePaneInput,
  onFitGeometry,
  policyInput,
  storage,
}: TerminalV2PooledRendererUiAdapterOptions): TerminalV2PooledRendererUiAdapterResult {
  if (!runtime) return { kind: "disabled", reason: "missing-runtime" };
  if (!hostContainer) return { kind: "disabled", reason: "missing-host" };

  const resolvedPolicyInput = policyInput ?? resolveTerminalV2PooledRendererUiPolicyInput({ storage });
  const policy = resolveTerminalV2PooledDomRendererPolicy(resolvedPolicyInput);
  if (!policy.enabled) return { kind: "disabled", reason: toDisabledPolicyReason(policy.reason) };

  const harness = createTerminalV2PooledDomRuntimeHarness({
    hostContainer,
    resolvePaneContainer,
    createRenderer,
    writePaneInput,
    onFitGeometry,
    policyInput: resolvedPolicyInput,
  });
  if (!harness) return { kind: "disabled", reason: toDisabledPolicyReason(policy.reason) };

  const uninstall = runtime.installPooledDomSlotFactory(harness.slotFactory);
  return {
    kind: "enabled",
    harness,
    dispose() {
      uninstall();
      harness.dispose();
    },
  };
}
