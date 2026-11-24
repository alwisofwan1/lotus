import type { ProviderId } from "@/modules/codespace/components/types";
import {
  isKnownProvider,
  listExecutors,
  resolve,
} from "@/modules/codespace/services/bridge/agent-registry";

export type AgentAddressCounters = Record<string, number>;

export type FleetProvider = ProviderId | "shell";

export type FleetIdentity = {
  provider: FleetProvider;
  providerSlug: string;
  providerDisplayName: string;
};

export type FleetTargetMember = {
  paneId: string;
  isAlive: boolean;
  agentAddress?: string;
  legacyAgentAddresses?: readonly string[];
  displayName?: string;
  aliases?: readonly string[];
};

function normalizeCommand(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeFleetToken(value: string): string {
  const raw = value.startsWith("@") ? value.slice(1) : value;
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function slugifyAgentAddress(value: string): string {
  return normalizeFleetToken(value) || "terminal";
}

function titleCase(value: string): string {
  return value
    .split(/[\s-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function commandHead(command: string): string | null {
  const token = command.trim().split(/\s+/, 1)[0] ?? "";
  return token || null;
}

export function detectFleetProvider(agentCommand?: string): FleetProvider {
  if (!agentCommand?.trim()) return "shell";
  const normalized = normalizeCommand(agentCommand);

  for (const spec of listExecutors()) {
    const specCommand = normalizeCommand(spec.command.join(" "));
    if (normalized === specCommand || normalized.startsWith(`${specCommand} `)) {
      return spec.id;
    }
  }

  const head = commandHead(normalized);
  if (!head) return "shell";
  return isKnownProvider(head) ? head : "shell";
}

export function displayNameForFleetProvider(provider: FleetProvider): string {
  if (provider === "shell") return "Shell";
  try {
    return resolve(provider).displayName.replace(/\s+\(Planner\)$/i, "");
  } catch {
    return titleCase(provider);
  }
}

export function deriveFleetIdentity(args: {
  agentCommand?: string;
  detectedProvider?: FleetProvider | null;
}): FleetIdentity {
  const fromCommand = detectFleetProvider(args.agentCommand);
  // (04) Runtime reality wins over birth intent when they disagree: `agentCommand` is only
  // what the pane was LAUNCHED with, but a pane can be handed off to a different CLI
  // mid-session, and `detectedProvider` (from fleet-output-tap) reflects what's ACTUALLY
  // running now. Previously the launch command always won, so a claude pane handed off to
  // codex stayed labeled "claude" forever.
  const provider =
    args.detectedProvider && args.detectedProvider !== fromCommand
      ? args.detectedProvider
      : fromCommand !== "shell"
        ? fromCommand
        : args.detectedProvider ?? "shell";
  const displayName = displayNameForFleetProvider(provider);
  return {
    provider,
    providerSlug: slugifyAgentAddress(
      provider.endsWith("-headless") ? provider.replace(/-headless$/, "") : provider,
    ),
    providerDisplayName: displayName,
  };
}

export function allocateAgentAddress(
  counters: AgentAddressCounters | undefined,
  agentCommand?: string,
): { agentAddress: string; counters: AgentAddressCounters } {
  const identity = deriveFleetIdentity({ agentCommand });
  const nextCounters = { ...(counters ?? {}) };
  const nextOrdinal = (nextCounters[identity.providerSlug] ?? 0) + 1;
  nextCounters[identity.providerSlug] = nextOrdinal;
  return {
    agentAddress: `${identity.providerSlug}-${nextOrdinal}`,
    counters: nextCounters,
  };
}

export function buildFleetAliases(member: {
  paneId: string;
  agentAddress?: string;
  legacyAgentAddresses?: readonly string[];
  displayName?: string;
}): string[] {
  const aliases = [
    member.agentAddress,
    ...(member.legacyAgentAddresses ?? []),
    member.displayName,
    member.paneId.slice(0, 8),
    member.paneId,
  ].filter((value): value is string => Boolean(value?.trim()));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    const normalized = normalizeFleetToken(alias);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(alias);
  }
  return out;
}

export function resolveFleetTarget<T extends FleetTargetMember>(
  fleet: readonly T[],
  rawToken: string,
): T | null {
  const token = rawToken.startsWith("@") ? rawToken.slice(1) : rawToken;
  if (!token.trim()) return null;

  const live = fleet.filter((member) => member.isAlive);
  const byPaneId = live.find((member) => member.paneId === token);
  if (byPaneId) return byPaneId;

  const normalized = normalizeFleetToken(token);
  const addressMatches = live.filter(
    (member) => normalizeFleetToken(member.agentAddress ?? "") === normalized,
  );
  if (addressMatches.length === 1) return addressMatches[0];

  const aliasMatches = live.filter((member) => {
    const aliases = member.aliases?.length
      ? member.aliases
      : buildFleetAliases(member);
    return aliases.some((alias) => normalizeFleetToken(alias) === normalized);
  });

  return aliasMatches.length === 1 ? aliasMatches[0] : null;
}
