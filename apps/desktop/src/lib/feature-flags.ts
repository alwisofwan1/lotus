import type { ClaudeSettings } from "@/modules/settings/types";

export type FeatureFlagId = "terminalRuntimeV2" | "terminalV2PooledDomRenderer";

export type FeatureFlagDefinition = {
  id: FeatureFlagId;
  label: string;
  description: string;
  defaultEnabled: boolean;
  owner: "codespace" | "platform";
};

export const TERMINAL_RUNTIME_V2_FLAG: FeatureFlagId = "terminalRuntimeV2";
export const TERMINAL_V2_POOLED_DOM_RENDERER_FLAG: FeatureFlagId = "terminalV2PooledDomRenderer";

export const FEATURE_FLAGS: readonly FeatureFlagDefinition[] = [
  {
    id: TERMINAL_RUNTIME_V2_FLAG,
    label: "Terminal Runtime V2",
    description:
      "Use the new scratch-built terminal runtime architecture for CodeSpace panes.",
    defaultEnabled: true,
    owner: "codespace",
  },
  {
    id: TERMINAL_V2_POOLED_DOM_RENDERER_FLAG,
    label: "Terminal V2 Pooled DOM Renderer",
    description:
      "Borrow pooled xterm renderer slots for local Terminal V2 panes, with legacy renderer fallback available.",
    defaultEnabled: true,
    owner: "codespace",
  },
] as const;

const FEATURE_FLAG_DEFAULTS = new Map<FeatureFlagId, boolean>(
  FEATURE_FLAGS.map((flag) => [flag.id, flag.defaultEnabled]),
);

export type FeatureFlagState = Record<FeatureFlagId, boolean>;

export function resolveFeatureFlag(
  settings: Pick<ClaudeSettings, "experimental"> | null | undefined,
  flagId: FeatureFlagId,
): boolean {
  const raw = settings?.experimental?.[flagId];
  if (typeof raw === "boolean") return raw;
  return FEATURE_FLAG_DEFAULTS.get(flagId) ?? false;
}

export function resolveFeatureFlags(
  settings: Pick<ClaudeSettings, "experimental"> | null | undefined,
): FeatureFlagState {
  return FEATURE_FLAGS.reduce((state, flag) => {
    state[flag.id] = resolveFeatureFlag(settings, flag.id);
    return state;
  }, {} as FeatureFlagState);
}

export function withFeatureFlag(
  settings: ClaudeSettings,
  flagId: FeatureFlagId,
  enabled: boolean,
): ClaudeSettings {
  return {
    ...settings,
    experimental: {
      ...(settings.experimental ?? {}),
      [flagId]: enabled,
    },
  };
}
