import type { AgentRunnerType } from "@/lib/agent-runtime";

export type RunnerVisualMark =
  | { kind: "logo"; src: string }
  | { kind: "glyph"; value: string }
  | { kind: "terminal" };

/**
 * The vendor a runner belongs to, for brand colour ONLY.
 *
 * Deliberately not the runner id: `claude`, `ccs` and `csp` are three runners wearing one brand,
 * and a custom Claude-family CLI is a fourth. Colour follows the logo, so it has to key off the
 * thing the logo already collapses them into.
 *
 * `generic` is the honest answer for a custom CLI we know nothing about — it takes the node-type
 * colour instead of borrowing a vendor's.
 */
export type RunnerBrand = "claude" | "chatgpt" | "cursor" | "generic";

export type RunnerVisualIdentity = {
  label: string;
  accessibleLabel: string;
  mark: RunnerVisualMark;
  brand: RunnerBrand;
};

export type ResolveRunnerVisualIdentityInput = {
  runner: AgentRunnerType;
  customRunner?: {
    id: string;
    name: string;
    claudeFamily: boolean;
  } | null;
};

const BUILT_IN_VISUALS: Record<
  Exclude<AgentRunnerType, "custom">,
  { label: string; accessibleLabel: string; src: string; brand: RunnerBrand }
> = {
  claude: { label: "Claude Code", accessibleLabel: "Claude", src: "/assets/ai-logo/Claude.svg", brand: "claude" },
  ccs: { label: "ccs", accessibleLabel: "Claude", src: "/assets/ai-logo/Claude.svg", brand: "claude" },
  csp: { label: "csp", accessibleLabel: "Claude", src: "/assets/ai-logo/Claude.svg", brand: "claude" },
  codex: { label: "Codex", accessibleLabel: "Codex", src: "/assets/ai-logo/ChatGPT.svg", brand: "chatgpt" },
  cursor: { label: "Cursor Agent", accessibleLabel: "Cursor", src: "/assets/ai-logo/Cursor.svg", brand: "cursor" },
};

export function resolveRunnerVisualIdentity({
  runner,
  customRunner,
}: ResolveRunnerVisualIdentityInput): RunnerVisualIdentity {
  if (runner === "custom" && customRunner?.claudeFamily) {
    return {
      label: customRunner.name,
      accessibleLabel: customRunner.name,
      mark: { kind: "logo", src: "/assets/ai-logo/Claude.svg" },
      brand: "claude",
    };
  }

  if (runner === "custom" && customRunner?.id === "custom-pi") {
    return {
      label: customRunner.name,
      accessibleLabel: customRunner.name,
      mark: { kind: "glyph", value: "π" },
      brand: "generic",
    };
  }

  if (runner === "custom") {
    const label = customRunner?.name || "CLI";
    return {
      label,
      accessibleLabel: label,
      mark: { kind: "terminal" },
      brand: "generic",
    };
  }

  const visual = BUILT_IN_VISUALS[runner];
  return {
    label: visual.label,
    accessibleLabel: visual.accessibleLabel,
    mark: { kind: "logo", src: visual.src },
    brand: visual.brand,
  };
}
