import { paneTitleSaysNothing } from "@/modules/codespace/services/pane-title/pane-title-normalizer";
import type { GridCell, PaneTitleStatus, TerminalCellData } from "@/modules/codespace/components/types";
import type {
  TerminalRuntimeStatus,
  TerminalSessionSnapshot,
} from "@/modules/codespace/services/terminal-session-registry";
import type { FleetOutputHints } from "./fleet-output-tap";
import {
  buildFleetAliases,
  deriveFleetIdentity,
  normalizeFleetToken,
  type FleetProvider,
} from "./fleet-naming";

export type { FleetProvider } from "./fleet-naming";

export type FleetMember = {
  paneId: string;
  workspaceId: string;
  cwd: string;
  provider: FleetProvider;
  /**
   * The runner as this window prints it (`Claude Code`, `Shell`) — the human half of
   * {@link FleetMember.provider}, which stays the machine-readable family a client routes
   * on. Carried so a remote client shows the same word the desktop does.
   *
   * Optional because it is derived: {@link deriveFleet} always fills it, and the many
   * hand-built members in tests have no opinion about it. Absent reads as "not named",
   * which is exactly how the wire field behaves.
   */
  runnerLabel?: string;
  displayName: string;
  agentAddress?: string;
  legacyAgentAddresses?: string[];
  /** The Agent Handle, when the pane has one: a name a person can address, unlike a provider label. */
  agentName?: string;
  aliases?: string[];
  status: TerminalRuntimeStatus;
  isAlive: boolean;
  lastOutputPreview?: string;
  /** Runtime PTY session id for cross-cell tools to dispatch/read directly. */
  sessionId?: string | null;
  /** Bridge role assigned to this cell (planner/implementer/reviewer/tester/refactor). */
  role?: string;
  /**
   * Auto-generated conversation title (slice 02 §6) — carried through so
   * `useMcpFleetPush` can send it as `headline`. Deliberately NOT part of `displayName`:
   * a title can be regenerated at any time, and a name that changes on its own defeats the
   * one thing that makes a name useful (something to call the cell by that stays put).
   */
  title?: string;
  titleStatus?: PaneTitleStatus;
};

// "idle" is included so a terminal cell that exists in the workspace but
// whose PTY session has not yet been registered (the React effect that
// calls createTerminalSession runs after mount) is still treated as alive.
// Without this, a race on cold-start causes Bridge to see the workspace as
// empty right as the user issues a "launch" prompt, leading to duplicate
// spawns stacked on top of the (soon-to-appear) existing cells.
const ALIVE_STATUSES: ReadonlySet<TerminalRuntimeStatus> = new Set<TerminalRuntimeStatus>([
  "idle",
  "starting",
  "live",
  "detached",
]);

/** The ordinal in `codex-2`, or null when `address` is not this provider's `<slug>-<n>`. */
function addressOrdinal(address: string, providerSlug: string): number | null {
  const normalized = normalizeFleetToken(address);
  const prefix = `${providerSlug}-`;
  if (!normalized.startsWith(prefix)) return null;
  const rest = normalized.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/**
 * Give every terminal cell a readable address (`claude-2`), not only the ones whose
 * provider was sniffed from output.
 *
 * `agentAddress` used to arrive from exactly one place — `promoteFleetTargetIdentity`,
 * driven by `fleet-output-tap`'s provider sniffer. That tap is in-memory and per-mount, so
 * a pane reattached after a reload never re-emits the banner it matches on and never gets
 * an address. Measured against the live fleet on 2026-09-12: five separate `claude` cells
 * published with no address at all, leaving a pane UUID as the only way to name one.
 *
 * So the address is derived here instead, from the provider this module has already
 * resolved. An explicitly-allocated address still wins — its ordinal is reserved in a first
 * pass, so the derived ones fill the gaps around it and can never collide with it.
 *
 * Scoped per `deriveFleet` call (= per workspace), like `agentAddressCounters` is, and
 * assigned before the caller filters out dead cells so a closing pane does not renumber its
 * neighbours mid-session.
 */
function resolveAgentAddresses(
  entries: readonly { paneId: string; providerSlug: string; agentAddress?: string }[],
): Map<string, string> {
  const reserved = new Map<string, Set<number>>();
  for (const entry of entries) {
    const explicit = entry.agentAddress?.trim();
    if (!explicit) continue;
    const ordinal = addressOrdinal(explicit, entry.providerSlug);
    if (ordinal === null) continue;
    const used = reserved.get(entry.providerSlug) ?? new Set<number>();
    used.add(ordinal);
    reserved.set(entry.providerSlug, used);
  }

  const addresses = new Map<string, string>();
  const cursor = new Map<string, number>();
  for (const entry of entries) {
    const explicit = entry.agentAddress?.trim();
    if (explicit) {
      addresses.set(entry.paneId, explicit);
      continue;
    }
    const used = reserved.get(entry.providerSlug);
    let ordinal = (cursor.get(entry.providerSlug) ?? 0) + 1;
    while (used?.has(ordinal)) ordinal += 1;
    cursor.set(entry.providerSlug, ordinal);
    addresses.set(entry.paneId, `${entry.providerSlug}-${ordinal}`);
  }
  return addresses;
}

export function deriveFleet(
  cells: readonly GridCell[],
  sessions: readonly TerminalSessionSnapshot[],
  workspaceId: string,
  outputHints?: FleetOutputHints,
): FleetMember[] {
  const sessionByPane = new Map<string, TerminalSessionSnapshot>();
  for (const s of sessions) {
    if (s.workspaceId !== workspaceId) continue;
    sessionByPane.set(s.paneId, s);
  }

  const terminals = cells.filter(
    (cell): cell is TerminalCellData => cell.type === "terminal",
  );
  const addresses = resolveAgentAddresses(
    terminals.map((terminal) => ({
      paneId: terminal.id,
      providerSlug: deriveFleetIdentity({
        agentCommand: terminal.agentCommand,
        detectedProvider:
          terminal.runtimeProvider ?? outputHints?.getDetectedProvider(terminal.id, terminal.agentCommand) ?? null,
      }).providerSlug,
      agentAddress: terminal.agentAddress,
    })),
  );

  const members: FleetMember[] = [];
  for (const terminal of terminals) {
    const snapshot = sessionByPane.get(terminal.id);
    // "idle" — no session registered yet. Distinguishes a pre-registration
    // cell (which is alive, session is being built) from a genuinely-closed
    // cell (which will have snapshot?.status === "exited").
    const status: TerminalRuntimeStatus = snapshot?.status ?? "idle";
    const fromOutput = outputHints?.getDetectedProvider(terminal.id, terminal.agentCommand) ?? null;
    const runtimeProvider = terminal.runtimeProvider ?? fromOutput;
    const identity = deriveFleetIdentity({
      agentCommand: terminal.agentCommand,
      detectedProvider: runtimeProvider,
    });
    const lastOutputPreview = outputHints?.getLastLine(terminal.id) || undefined;
    // The Agent Handle (Nara, Bima, …, or what a rename made it); the provider label is the last resort.
    const displayName =
      terminal.agentName?.trim() ||
      identity.providerDisplayName;
    const agentAddress = addresses.get(terminal.id) ?? terminal.agentAddress;
    members.push({
      paneId: terminal.id,
      agentAddress,
      legacyAgentAddresses: terminal.legacyAgentAddresses,
      workspaceId,
      cwd: terminal.cwd,
      provider: identity.provider,
      runnerLabel: identity.providerDisplayName,
      displayName,
      agentName: terminal.agentName,
      aliases: buildFleetAliases({
        paneId: terminal.id,
        agentAddress,
        legacyAgentAddresses: terminal.legacyAgentAddresses,
        displayName,
      }),
      status,
      isAlive: ALIVE_STATUSES.has(status),
      lastOutputPreview,
      sessionId: snapshot?.sessionId ?? null,
      role: terminal.role,
      /*
        A name that says nothing is not published.

        The rail already hides such a name; the fleet asked nobody, so "Transcript not readable"
        and a pane named after its launch flag were being advertised to every other agent and to
        the phone (seen 2026-09-21). One rule, read here as well as there — `paneTitleSaysNothing`.
      */
      title: paneTitleSaysNothing(terminal.title, {
        agentCommand: terminal.agentCommand,
        cwd: terminal.cwd,
        agentName: terminal.agentName,
      })
        ? undefined
        : terminal.title,
      titleStatus: terminal.titleStatus,
    });
  }
  return members;
}
