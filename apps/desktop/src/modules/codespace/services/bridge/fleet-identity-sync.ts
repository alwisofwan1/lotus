import type {
  ExecutorProviderId,
  GridCell,
  TerminalCellData,
  Workspace,
} from "@/modules/codespace/components/types";
import {
  allocateAgentAddress,
  normalizeFleetToken,
  slugifyAgentAddress,
} from "./fleet-naming";
import { DEFAULT_AGENT_NAME_POOL, uniqueAgentName } from "@/lib/agent-catalog";

function addressProviderSlug(address: string | undefined): string | null {
  const normalized = normalizeFleetToken(address ?? "");
  const match = /^(.+)-\d+$/.exec(normalized);
  return match?.[1] ?? null;
}

function belongsToProvider(address: string | undefined, provider: ExecutorProviderId): boolean {
  return addressProviderSlug(address) === slugifyAgentAddress(provider);
}

function appendLegacyAddress(
  current: readonly string[] | undefined,
  previousAddress: string | undefined,
): string[] | undefined {
  const trimmed = previousAddress?.trim();
  if (!trimmed) return current ? [...current] : undefined;
  const out = [...(current ?? [])];
  const normalized = normalizeFleetToken(trimmed);
  if (!out.some((alias) => normalizeFleetToken(alias) === normalized)) {
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

function replaceCell(
  cells: readonly GridCell[],
  cellId: string,
  nextCell: TerminalCellData,
): GridCell[] {
  return cells.map((cell) => (cell.id === cellId ? nextCell : cell));
}

/**
 * Names already in use by OTHER terminal cells in this workspace — a name may repeat across
 * workspaces (real uniqueness is agentAddress + workspace scoping), so this deliberately never
 * looks outside `workspace`.
 */
function takenAgentNames(workspace: Workspace, excludeCellId: string): string[] {
  return workspace.cells
    .filter((c): c is TerminalCellData => c.type === "terminal" && c.id !== excludeCellId)
    .map((c) => c.agentName)
    .filter((n): n is string => Boolean(n?.trim()));
}

/**
 * Slice 02 §4: a pane that STARTED as shell and was promoted to an agent is the majority case
 * on this machine (shell, then `claude` typed into it) — without this, those panes are the ones
 * that stay nameless / fall back to the provider label forever. Only fills a name that isn't
 * there yet; never overwrites one a cell already carries.
 */
function withAgentName(
  cell: TerminalCellData,
  workspace: Workspace,
  pool: readonly string[],
): TerminalCellData {
  if (cell.agentName) return cell;
  return { ...cell, agentName: uniqueAgentName("", takenAgentNames(workspace, cell.id), pool) };
}

/**
 * Promote a terminal cell to the active runtime provider detected from its
 * output. Address allocation is monotonic and workspace-scoped; the previous
 * canonical address remains as a Legacy Alias for resolver compatibility.
 *
 * `pool` is a parameter, not read from settings in here: this stays a pure function (same
 * `workspace`/`cellId`/`runtimeProvider`/`pool` always yields the same result) — the caller
 * (`useFleetIdentitySync`) resolves the locale-appropriate pool and passes it in.
 */
export function promoteFleetTargetIdentity(
  workspace: Workspace,
  cellId: string,
  runtimeProvider: ExecutorProviderId,
  pool: readonly string[] = DEFAULT_AGENT_NAME_POOL,
): Workspace {
  const cell = workspace.cells.find(
    (candidate): candidate is TerminalCellData =>
      candidate.id === cellId && candidate.type === "terminal",
  );
  if (!cell) return workspace;

  if (belongsToProvider(cell.agentAddress, runtimeProvider)) {
    if (cell.runtimeProvider === runtimeProvider && cell.agentName) return workspace;
    const nextCell = withAgentName({ ...cell, runtimeProvider }, workspace, pool);
    return { ...workspace, cells: replaceCell(workspace.cells, cellId, nextCell) };
  }

  const allocated = allocateAgentAddress(workspace.agentAddressCounters, runtimeProvider);
  const nextCell = withAgentName(
    {
      ...cell,
      agentAddress: allocated.agentAddress,
      legacyAgentAddresses: appendLegacyAddress(cell.legacyAgentAddresses, cell.agentAddress),
      runtimeProvider,
    },
    workspace,
    pool,
  );

  return {
    ...workspace,
    agentAddressCounters: allocated.counters,
    cells: replaceCell(workspace.cells, cellId, nextCell),
  };
}
