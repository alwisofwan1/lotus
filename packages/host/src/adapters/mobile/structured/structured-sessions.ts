import { randomUUID } from "node:crypto";

import type { BridgeProvider } from "../../../types/api.js";
import type { ConversationPage, Turn } from "../../../types/conversation.js";
import type { FleetMember } from "../../../types/fleet.js";
import type { PermissionResponse } from "../../../types/permission.js";
import type { PromptAttachment, ProviderBridgeFactory, ProviderBridgeSession } from "../../../types/provider-bridge.js";
import type { TranscriptResponse } from "../../../types/transcript.js";
import { BridgeRegistry } from "./bridge-registry.js";
import type { SavedCell, SavedSpawn } from "./cell-book.js";
import { EndedSession } from "./ended-session.js";
import { entriesFromTurns } from "./entries-from-parts.js";
import { applyCellUpdate } from "./cell-updates.js";
import { cellMember, type Held } from "./cell-shapes.js";
import { permissionReport } from "./pending-report.js";
import { closeCutTurn, endedTurn, genTurns, savedTurns } from "./saved-turns.js";
import type { StructuredSessionsDeps, StructuredSpawnRequest } from "./session-shapes.js";

export { codexOnPath, codexPosture } from "./bridges/codex.js";

/**
 * Structured-protocol agents with no terminal (Fase 4); runner, scale and spawn live behind
 * [`ProviderBridgeFactory`] (`bridge-registry.ts`). They look like any cell downstream (own
 * `paneId`, `/transcript`, `/permission`), so older phones need no update.
 */
export type { StructuredSessionsDeps, StructuredSpawnRequest } from "./session-shapes.js";

export class StructuredSessions {
  private readonly held = new Map<string, Held>();

  /** Ends every process (an orphaned `codex app-server` would outlive the host) but keeps each cell saved for `restore`. */
  closeAll(): void {
    for (const h of this.held.values()) { this.save(h); h.session.close(); }
    this.held.clear();
  }

  /** Brings back the cells a previous host process saved, same paneId, conversation resumed. */
  async restore(): Promise<void> {
    for (const saved of this.deps.book?.all() ?? []) {
      await this.reopen(saved.member, saved.spawn, closeCutTurn(saved.turns, Date.now()), saved.thread);
    }
    this.deps.fleetChanged();
  }

  /** Starts a cell's runner again on its own conversation; a cell that cannot is kept, ended and saying why. */
  private async reopen(member: FleetMember, spawn: SavedSpawn, prior: Turn[], thread: string | undefined): Promise<boolean> {
    const { agentType, paneId } = member;
    const bridge = this.canRun(agentType) ? this.registry.find(agentType) : undefined;
    try {
      if (bridge === undefined) throw new Error(`${member.runnerLabel} is not available on this host`);
      await this.open(bridge, member, spawn, prior, thread);
      return true;
    } catch (err) {
      this.held.get(paneId)?.session.close();
      const reason = endedTurn(err instanceof Error ? err.message : String(err), Date.now());
      this.hold(member, new EndedSession(paneId, agentType, thread), spawn, [...prior, reason]);
      return false;
    }
  }

  /** A runner that died under a live host (crash, OOM) comes back on the next message, once however many arrive. */
  private revive(h: Held): Promise<boolean> {
    const paneId = h.member.paneId;
    const running = this.reviving.get(paneId);
    if (running !== undefined) return running;
    const prior = closeCutTurn(savedTurns(h.prior, genTurns(h.session.conversation.page().turns, h.gen)), Date.now());
    h.session.close();
    const revived = this.reopen(h.member, h.spawn, prior, h.session.thread ?? h.resumed)
      .finally(() => { this.reviving.delete(paneId); this.deps.fleetChanged(); });
    this.reviving.set(paneId, revived);
    return revived;
  }

  private readonly reviving = new Map<string, Promise<boolean>>();

  private readonly registry: BridgeRegistry;

  constructor(private readonly deps: StructuredSessionsDeps) {
    this.registry =
      deps.registry ??
      new BridgeRegistry(deps.createSession === undefined ? {} : { createCodexSession: deps.createSession });
  }

  has(paneId: string): boolean {
    return this.held.has(paneId);
  }

  /**
   * Runners startable without a terminal, from the registry (not a constant): `codex` without
   * `cursor-agent` advertises exactly one.
   */
  headlessRunners(): BridgeProvider[] {
    return this.registry.available().map((f) => f.agentType);
  }

  /**
   * The same runners, each with the name the operator reads.
   *
   * A bridge-only provider such as `cursor` has no terminal runner to take a name from.
   */
  headlessRunnerRows(): Array<{ id: BridgeProvider; label: string }> {
    return this.registry.available().map((f) => ({ id: f.agentType, label: f.runnerLabel }));
  }

  /** A predicate, so a route that passes this check may hand the name straight to `spawn`. */
  canRun(agentType: string): agentType is BridgeProvider {
    return this.headlessRunners().some((id) => id === agentType);
  }

  /**
   * Names already spoken for, so a generated one does not repeat. Structured cells only: this
   * store cannot see the host's PTY panes, and a name shared with one is harmless — nothing
   * addresses a cell by name. Two headless cells sharing one is the case people tripped over.
   */
  private titles(): string[] {
    return [...this.held.values()].map((held) => held.member.title);
  }

  /** As the fleet sees them, optionally one workspace's worth. */
  list(workspaceId?: string): FleetMember[] {
    const now = Date.now();
    return [...this.held.values()]
      .filter((h) => workspaceId === undefined || h.member.workspaceId === workspaceId)
      .map((h) => {
        // Read per call, not remembered on the member: a plan window changes under a cell
        // that is doing nothing, and a snapshot is exactly when a client asks about it.
        const usage = h.session.usage?.();
        return {
          ...h.member,
          isAlive: h.session.alive, terminal: false,
          turn: h.turn,
          turnAgeMs: now - h.turnChangedAt,
          ...(usage === undefined ? {} : { usage }),
        };
      });
  }

  async spawn(req: StructuredSpawnRequest): Promise<FleetMember> {
    const paneId = `ss-${randomUUID().slice(0, 8)}`;
    const agentType = req.agentType ?? "codex";
    const bridge = this.registry.find(agentType);
    if (bridge === undefined) throw new Error(`no provider bridge for "${agentType}" on this host`);
    const spawn: SavedSpawn = {
      cwd: req.cwd,
      ...(req.permissionMode === undefined ? {} : { permissionMode: req.permissionMode }),
      ...(req.model === undefined ? {} : { model: req.model }),
      ...(req.effort === undefined ? {} : { effort: req.effort }),
      ...(req.profileId === undefined ? {} : { profileId: req.profileId }),
    };
    const member = cellMember(paneId, req, bridge, this.titles());
    await this.open(bridge, member, spawn, []);
    this.deps.fleetChanged();
    // Same reason as `dispatch`: a spawn that waited for the first turn would answer the
    // phone only after the work finished, and never at all if that turn stopped to ask.
    if (req.initialPrompt !== undefined) void this.dispatch(paneId, req.initialPrompt);
    return this.list().find((m) => m.paneId === paneId) ?? member;
  }

  private async open(bridge: ProviderBridgeFactory, member: FleetMember, spawn: SavedSpawn, prior: Turn[], resume?: string): Promise<void> {
    const session = bridge.create({ paneId: member.paneId, ...spawn, ...(resume === undefined ? {} : { resume }) });
    const held = this.hold(member, session, spawn, prior);
    if (resume !== undefined) held.resumed = resume;
    session.conversation.onUpdate((u) => applyCellUpdate(held, u, this.deps, (h) => this.save(h)));
    await session.start();
    held.member.sessionId = session.thread ?? member.paneId;
    this.save(held);
  }

  private hold(member: FleetMember, session: ProviderBridgeSession, spawn: SavedSpawn, prior: Turn[]): Held {
    const held: Held = { member, session, spawn, prior, gen: randomUUID().slice(0, 6), turn: "idle", turnChangedAt: Date.now() };
    this.held.set(member.paneId, held);
    return held;
  }

  private save(h: Held): void {
    const thread = h.session.thread ?? h.resumed;
    const cell: SavedCell = { member: h.member, spawn: h.spawn, turns: savedTurns(h.prior, genTurns(h.session.conversation.page().turns, h.gen)) };
    this.deps.book?.put(thread === undefined ? cell : { ...cell, thread });
  }

  /**
   * `blocked`: a cell with a pending permission holds a question, not messages; a silent 200
   * there did nothing. `/input` is the route that answers.
   */
  async dispatch(paneId: string, text: string, attachments: readonly PromptAttachment[] = []): Promise<"sent" | "blocked" | "unknown"> {
    let h = this.held.get(paneId);
    if (h === undefined) return "unknown";
    if (!h.session.alive) {
      if (!(await this.revive(h))) return "unknown";
      h = this.held.get(paneId);
      if (h === undefined) return "unknown";
    }
    if (h.session.conversation.pendingPermission() !== undefined) return "blocked";
    // Not awaited: Codex's `prompt()` resolves on accept but ACP's and Claude's resolve when the
    // turn ends, which hangs this route — forever on an approval, whose answer arrives on `/input`.
    // `sent` means *handed to the runner*; failures land on the conversation lane as an error turn.
    void h.session.prompt(text, attachments).catch(() => undefined);
    return "sent";
  }

  async stop(paneId: string): Promise<boolean> {
    const h = this.held.get(paneId);
    if (h === undefined) return false;
    await h.session.interrupt();
    return true;
  }

  /** A key press. The only keys a structured cell knows are the permission digits. */
  input(paneId: string, data: string): boolean {
    const h = this.held.get(paneId);
    return h !== undefined && h.session.decide(data.trim());
  }

  /**
   * `false` (no pane, no translation, or session cannot take it) means the posture on screen
   * is still in force. Never report a change that did not happen.
   */
  async setPosture(paneId: string, mode: string): Promise<boolean> {
    const h = this.held.get(paneId);
    if (h === undefined) return false;
    const factory = this.registry.find(h.member.agentType);
    if (factory?.posture === undefined || h.session.setPermissionMode === undefined) return false;
    await h.session.setPermissionMode(factory.posture(mode));
    return true;
  }

  close(paneId: string): boolean {
    const h = this.held.get(paneId);
    if (h === undefined) return false;
    h.session.close();
    this.held.delete(paneId);
    this.deps.book?.remove(paneId);
    this.deps.fleetChanged();
    return true;
  }

  page(paneId: string): ConversationPage | undefined {
    const h = this.held.get(paneId);
    if (h === undefined) return undefined;
    const live = h.session.conversation.page();
    return { ...live, turns: [...h.prior, ...genTurns(live.turns, h.gen)] };
  }

  transcript(paneId: string): TranscriptResponse | undefined {
    const page = this.page(paneId);
    if (page === undefined) return undefined;
    const entries = entriesFromTurns(page.turns);
    return { paneId, total: entries.length, entries, source: "file", hasMore: false, totalEver: entries.length };
  }

  permission(paneId: string): PermissionResponse | undefined {
    const h = this.held.get(paneId);
    return h === undefined ? undefined : permissionReport(paneId, h.session.conversation);
  }
}
