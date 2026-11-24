export const TERMINAL_V2_POOLED_DOM_RENDERER_STORAGE_KEY = "lotus:terminal-v2-pooled-dom-renderer";

export type TerminalV2PooledDomRendererPolicyInput = {
  environment?: string;
  storageValue?: string | null;
  featureEnabled?: boolean;
};

export type TerminalV2PooledDomRendererPolicy = {
  enabled: boolean;
  reason: "enabled" | "not-enabled" | "production" | "disabled-by-flag";
};

export function resolveTerminalV2PooledDomRendererPolicy({
  environment = process.env.NODE_ENV,
  storageValue = null,
  featureEnabled,
}: TerminalV2PooledDomRendererPolicyInput): TerminalV2PooledDomRendererPolicy {
  if (featureEnabled === false) {
    return { enabled: false, reason: "disabled-by-flag" };
  }
  if (storageValue === "0") {
    return { enabled: false, reason: "not-enabled" };
  }
  if (environment === "production" && featureEnabled !== true) {
    return { enabled: false, reason: "production" };
  }
  if (storageValue === "1" || featureEnabled === true) {
    return { enabled: true, reason: "enabled" };
  }
  return { enabled: false, reason: "not-enabled" };
}
