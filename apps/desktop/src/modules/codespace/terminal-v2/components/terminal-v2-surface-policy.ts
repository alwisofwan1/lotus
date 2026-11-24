export type TerminalV2SurfaceFallbackReason =
  | "feature-disabled"
  | "runtime-inactive"
  | "eligible";

export type TerminalV2SurfacePolicyInput = {
  featureEnabled: boolean;
  runtimeActive: boolean;
};

export type TerminalV2SurfacePolicy = {
  useV2: boolean;
  reason: TerminalV2SurfaceFallbackReason;
};

export function resolveTerminalV2SurfacePolicy({
  featureEnabled,
  runtimeActive,
}: TerminalV2SurfacePolicyInput): TerminalV2SurfacePolicy {
  if (!featureEnabled) return { useV2: false, reason: "feature-disabled" };
  if (!runtimeActive) return { useV2: false, reason: "runtime-inactive" };
  return { useV2: true, reason: "eligible" };
}
