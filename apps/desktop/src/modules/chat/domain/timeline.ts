// Projects a ThreadState into the rows the chat timeline renders. Pure. The row model follows bb
// `packages/thread-view` (MIT): conversation rows for what people say, work rows for what the
// agent does in between, grouped into one step summary each.
//
// Grouping rule: inside a turn, every run of items between two agent messages is one work row.

import { isPlanItem } from "./plan";
import type { Attachment, ItemStatus, ThreadItem } from "./thread-event";
import type { InteractionState, ItemState, ThreadState, TurnState } from "./thread-state";

export interface WorkStep {
  item: ThreadItem;
  title: string;
  startedAt: number;
  endedAt: number | null;
  // The permission request for this step, if one was asked.
  interaction: InteractionState | null;
  // 0 at the top level; a sub-agent's own steps sit one deeper than its Agent call.
  depth: number;
}

export type WorkStatus = "running" | "needsApproval" | "completed" | "failed" | "interrupted";

export type TimelineRow =
  | {
      kind: "user";
      id: string;
      turnId: string;
      text: string;
      clientRequestId: string;
      attachments: Attachment[];
      /** When it was sent; absent on a message shown before its echo. */
      at?: number;
      /** Edit (mockups/chat-user-actions.html): true, or why not; absent for a steer (no Edit at all). */
      edit?: true | string;
      /** The chat's first message: editing it starts a fresh session, so any agent can. */
      first?: true;
    }
  | {
      kind: "assistant";
      id: string;
      turnId: string;
      text: string;
      streaming: boolean;
      /**
       * On the last reply of a completed turn, the turn's start: files it names that changed since
       * (what the turn made) are drawn as cards under it.
       */
      filesSince?: number;
      /** On the same closing reply: what its action row's menu shows, and whether it can fork. */
      turnEnd?: TurnEnd;
    }
  | {
      kind: "work";
      id: string;
      turnId: string;
      steps: WorkStep[];
      summary: string;
      status: WorkStatus;
      startedAt: number;
      endedAt: number | null;
    }
  // A permission request that is not tied to a step the timeline knows.
  | { kind: "approval"; id: string; turnId: string | null; interaction: InteractionState }
  | { kind: "notice"; id: string; turnId: string | null; tone: "info" | "warning" | "error"; text: string }
  // The chat sat quiet for at least GAP_MS before this turn (mockups/chat-composer-ux-audit.html, P1).
  | { kind: "gap"; id: string; turnId: string; at: number; afterMs: number }
  // This chat is a fork of another one, made after the turns above (mockups/chat-fork-turn.html).
  | {
      kind: "fork";
      id: string;
      turnId: null;
      fromThreadId: string;
      fromTitle: string;
      turn: number;
      /** Its own worktree's branch; null while it shares the original's folder. */
      worktree: string | null;
      /** It has not worked yet, so it can still move into a worktree at that turn. */
      canMove: boolean;
    };

export interface TurnEnd {
  /** 1-based, as the user counts turns. */
  index: number;
  endedAt: number;
  durationMs: number | null;
  costUsd: number | null;
  forkable: boolean;
}

/** A pause this long or longer gets a divider; below it the conversation still reads as one. */
export const GAP_MS = 30 * 60_000;

const CONTEXT_COMMANDS: Record<string, { running: string; done: string }> = {
  "/clear": { running: "Clearing context…", done: "Context cleared" },
  "/compact": { running: "Compacting context…", done: "Context compacted" },
};

/** The last reply's first line of text, without Markdown marks: the one line wide mode shows above its composer. */
export function lastLine(rows: readonly TimelineRow[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind !== "assistant") continue;
    const line = row.text
      .split("\n")
      .map((l) => l.replace(/^\s*(#+|[-*>]|\d+\.)\s+/, "").replace(/[*_`]/g, "").trim())
      .find(Boolean);
    if (line) return line;
  }
  return "";
}

export function buildTimelineRows(state: ThreadState): TimelineRow[] {
  const cwd = state.session.cwd;
  const byItem = new Map<string, InteractionState>();
  for (const i of state.interactions) if (i.interaction.itemId) byItem.set(i.interaction.itemId, i);
  const placed = new Set<string>();

  const rows: TimelineRow[] = [];
  const switchesAfter = (count: number) => {
    // A pick before the first message is just the starting model, not a switch.
    if (count === 0) return;
    state.modelSwitches.forEach((s, index) => {
      if (s.afterTurns === count) {
        rows.push({ kind: "notice", id: `model:${index}`, turnId: null, tone: "info", text: `Switched to ${s.label}` });
      }
    });
  };
  let lastActive: number | null = null;
  const turns = adoptLateSteps(state.turns);
  const busy = turns.some((t) => t.status === "running");
  // Editing goes back to where the turn before ended, as a fork does.
  const editable = (turnIndex: number, attachments: readonly Attachment[], text = ""): true | string => {
    if (busy) return "Wait for the reply";
    if (attachments.length > 0) return "Can't edit a message with files";
    if (shownText(text) !== text) return "Can't edit a delegated task";
    if (turnIndex > 0 && !turns[turnIndex - 1].forkPoint) return "Can't edit this message";
    return true;
  };
  for (const [turnIndex, turn] of turns.entries()) {
    if (lastActive !== null && turn.startedAt - lastActive >= GAP_MS) {
      rows.push({ kind: "gap", id: `${turn.id}:gap`, turnId: turn.id, at: turn.startedAt, afterMs: turn.startedAt - lastActive });
    }
    // A turn Lotus never saw end (closed mid-run) still counts from its last step.
    lastActive = Math.max(turn.startedAt, turn.endedAt ?? 0, ...turn.items.map((e) => e.endedAt ?? e.startedAt));
    // Only when the agent ran it: a reply means it took the text as a message (an agent or bridge
    // without the command). A failed or stopped one also stays the user's message, error below.
    const ran = turn.status !== "failed" && turn.status !== "interrupted" && !turn.items.some((e) => e.item.kind === "agentMessage");
    // Claude sometimes reports the message as the turn's first item instead of its input.
    const first = turn.items[0]?.item;
    const opener = turn.input ?? (first?.kind === "userMessage" ? first : null);
    const command = opener && ran ? CONTEXT_COMMANDS[opener.text.trim()] : undefined;
    if (command) {
      // A context command shows as a line, not a message; the history above stays on screen.
      rows.push({ kind: "notice", id: `${turn.id}:input`, turnId: turn.id, tone: "info", text: turn.status === "running" ? command.running : command.done });
    } else if (turn.input) {
      rows.push({
        kind: "user",
        id: `${turn.id}:input`,
        turnId: turn.id,
        text: shownText(turn.input.text),
        clientRequestId: turn.input.clientRequestId,
        attachments: turn.input.attachments ?? [],
        at: turn.startedAt,
        edit: editable(turnIndex, turn.input.attachments ?? [], turn.input.text),
        ...(turnIndex === 0 ? { first: true as const } : {}),
      });
    }
    let group: ItemState[] = [];
    const flush = (tail = false) => {
      // The run the agent is still in stays live between its steps: Claude ends one before the next
      // starts, and in that gap every step reads as done.
      const row = workRow(turn, group, byItem, placed, cwd, tail && turn.status === "running");
      if (row) rows.push(row);
      group = [];
    };
    for (const entry of turn.items) {
      if (entry.item.kind === "userMessage") {
        if (command && entry.item === opener) continue;
        flush();
        rows.push({
          kind: "user",
          id: entry.item.id,
          turnId: turn.id,
          text: shownText(entry.item.text),
          clientRequestId: entry.item.clientRequestId,
          attachments: entry.item.attachments ?? [],
          at: entry.startedAt,
          // Only the message that opened the turn; a steer lives inside it.
          ...(!turn.input && entry.item === opener ? { edit: editable(turnIndex, entry.item.attachments ?? []), ...(turnIndex === 0 ? { first: true as const } : {}) } : {}),
        });
        continue;
      }
      // A sub-agent's reply goes back to its agent, not to the user: it is a step.
      if (entry.item.kind !== "agentMessage" || entry.item.parentId) {
        group.push(entry);
        continue;
      }
      // Codex empties a message a steer cut short; there is nothing left to show.
      if (entry.item.status !== "running" && !entry.item.text.trim()) continue;
      flush();
      rows.push({
        kind: "assistant",
        id: entry.item.id,
        turnId: turn.id,
        text: entry.item.text,
        streaming: entry.item.status === "running",
      });
    }
    flush(true);
    // The closing reply's files show once it is in, not after the Stop hooks that hold `turn/completed`.
    if (turn.status === "running" && turn.answered) {
      const at = rows.findLastIndex((r) => r.turnId === turn.id && r.kind === "assistant");
      const row = rows[at] as Extract<TimelineRow, { kind: "assistant" }> | undefined;
      if (row && !row.streaming) rows[at] = { ...row, filesSince: turn.startedAt };
    }
    if (turn.status === "completed") {
      // Only the closing reply: the narration between steps names every file it reads.
      const at = rows.findLastIndex((r) => r.turnId === turn.id && r.kind === "assistant");
      const turnEnd: TurnEnd = {
        index: turnIndex + 1,
        endedAt: turn.endedAt ?? turn.startedAt,
        durationMs: turn.usage?.durationMs ?? (turn.endedAt !== null ? turn.endedAt - turn.startedAt : null),
        costUsd: turn.usage?.costUsd ?? null,
        forkable: !!turn.forkPoint,
      };
      if (at >= 0) rows[at] = { ...(rows[at] as Extract<TimelineRow, { kind: "assistant" }>), filesSince: turn.startedAt, turnEnd };
    }
    if (turn.status === "interrupted") {
      rows.push({ kind: "notice", id: `${turn.id}:end`, turnId: turn.id, tone: "warning", text: "Stopped." });
    } else if (turn.status === "failed") {
      rows.push({ kind: "notice", id: `${turn.id}:end`, turnId: turn.id, tone: "error", text: turn.error ?? "The turn failed." });
    }
    switchesAfter(turnIndex + 1);
    const fork = state.forkedFrom;
    if (fork && fork.afterTurns === turnIndex + 1) {
      rows.push({
        kind: "fork",
        id: "fork",
        turnId: null,
        fromThreadId: fork.threadId,
        fromTitle: fork.title,
        turn: fork.turn,
        worktree: fork.worktree ?? null,
        canMove: !fork.worktree && state.turns.length === fork.afterTurns,
      });
    }
  }

  for (const interaction of state.interactions) {
    if (placed.has(interaction.interaction.id) || interaction.resolution) continue;
    rows.push({ kind: "approval", id: interaction.interaction.id, turnId: interaction.turnId, interaction });
  }
  if (state.session.ended && state.session.error) {
    rows.push({ kind: "notice", id: "session:end", turnId: null, tone: "error", text: state.session.error });
  }
  return rows;
}

/**
 * A background sub-agent reports after its lead's turn ended, so its steps arrive in a later turn,
 * where its Agent call is not: seen live 2026-11-05 as a stray "Reply · 3 steps" group. Each such
 * step goes back to the turn of the call it belongs to, right after that call's last step.
 */
export function adoptLateSteps(turns: readonly TurnState[]): TurnState[] {
  const turnOf = new Map<string, number>();
  const out = turns.map((turn) => ({ ...turn, items: [...turn.items] }));
  for (const [index, turn] of turns.entries()) {
    const kept: ItemState[] = [];
    for (const entry of turn.items) {
      const home = entry.item.parentId === undefined ? undefined : turnOf.get(entry.item.parentId);
      if (home === undefined || home === index) {
        turnOf.set(entry.item.id, index);
        kept.push(entry);
        continue;
      }
      turnOf.set(entry.item.id, home);
      const items = out[home].items;
      // After the last step of this call's branch: the call itself or anything already under it.
      const branch = new Set([entry.item.parentId]);
      let at = -1;
      items.forEach((e, i) => {
        if (branch.has(e.item.id) || (e.item.parentId && branch.has(e.item.parentId))) {
          branch.add(e.item.id);
          at = i;
        }
      });
      items.splice(at + 1, 0, entry);
    }
    out[index].items = kept;
  }
  return out;
}

function workRow(
  turn: TurnState,
  group: ItemState[],
  byItem: Map<string, InteractionState>,
  placed: Set<string>,
  cwd: string | null,
  live: boolean,
): TimelineRow | null {
  // A finished empty thought (the model hides its thinking) says nothing. Keep it while running, or
  // while its run is live, so the row can show that the agent is thinking; the card never lists it.
  // The plan tool shows as the plan line above the composer, not as a step.
  const shown = group.filter(
    (e) => !isPlanItem(e.item) && !(e.item.kind === "reasoning" && e.item.text.trim() === "" && e.item.status !== "running" && !live),
  );
  if (shown.length === 0) return null;
  const parentOf = new Map(turn.items.map((e) => [e.item.id, e.item.parentId]));
  const depthOf = (id: string | undefined, seen = 0): number => (id && seen < 8 ? 1 + depthOf(parentOf.get(id), seen + 1) : 0);
  const steps = shown.map((entry): WorkStep => {
    const interaction = byItem.get(entry.item.id) ?? null;
    if (interaction) placed.add(interaction.interaction.id);
    return {
      item: entry.item,
      title: stepTitle(entry.item, cwd),
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      interaction,
      depth: depthOf(entry.item.parentId),
    };
  });
  const ends = steps.map((s) => s.endedAt);
  const status = workStatus(steps);
  const held = live && status === "completed";
  return {
    kind: "work",
    // From the group, not `shown`: a dropped empty thought must not change the row's identity.
    id: `${turn.id}:work:${group[0].item.id}`,
    turnId: turn.id,
    steps,
    summary: summarizeSteps(steps),
    status: held ? "running" : status,
    startedAt: steps[0].startedAt,
    endedAt: held || ends.includes(null) ? null : Math.max(...(ends as number[])),
  };
}

function workStatus(steps: WorkStep[]): WorkStatus {
  const statuses = new Set<ItemStatus>(steps.map((s) => s.item.status));
  if (steps.some((s) => s.interaction && !s.interaction.resolution)) return "needsApproval";
  if (statuses.has("running")) return "running";
  // A sub-agent's own failed step (a Read of a missing file) is its to recover from, not the lead's.
  const own = new Set<ItemStatus>(steps.filter((s) => s.depth === 0).map((s) => s.item.status));
  if (own.has("failed")) return "failed";
  if (own.has("interrupted")) return "interrupted";
  return "completed";
}

/** A delegated chat's first message opens with Lotus's note to the agent; the person reads the task. */
export function shownText(text: string): string {
  return text.replace(/^<lotus-delegation\b[^>]*>[\s\S]*?<\/lotus-delegation>\s*/, "");
}

export function stepTitle(item: ThreadItem, cwd: string | null): string {
  switch (item.kind) {
    case "reasoning":
      return item.status === "running" ? "Thinking" : "Thought";
    case "agentMessage":
      return "Reply";
    case "userMessage":
      return "Message";
    case "command":
      // "cd <dir> && …" says where, not what; the rest is the command.
      return `Ran ${firstLine(relativeToCwd(item.command, cwd).replace(/^cd\s+\S+\s*(?:&&|;)\s*(?=\S)/, ""))}`;
    case "fileRead":
      return `Read ${displayPath(item.path, cwd)}`;
    case "fileChange":
      return `${item.change === "create" ? "Created" : "Edited"} ${displayPath(item.path, cwd)}`;
    case "search":
      return `Searched for ${item.query}`;
    case "tool": {
      const agent = subAgent(item);
      if (agent) return `${agent.delegated ? "Delegated to" : "Ran"} ${agent.type ?? "agent"}${agent.description ? `: ${agent.description}` : ""}`;
      const waited = agentWait(item);
      if (waited !== null) return waited ? `Waited for ${plural(waited, "agent")}` : "Waited for agents";
      return `Used ${toolParts(item.name).tool}`;
    }
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * A sub-agent call, with what it was asked to do: Claude's own (the Agent tool, `Task` before it
 * was renamed), or a Lotus delegation (`lotus_chat_delegate`), which says the model it went to.
 */
export function subAgent(item: ThreadItem): { type: string | null; description: string | null; delegated: boolean } | null {
  if (item.kind !== "tool") return null;
  const input = (item.input ?? {}) as Record<string, unknown>;
  if (item.name === "Agent" || item.name === "Task") {
    return { type: str(input.subagent_type), description: str(input.description), delegated: false };
  }
  if (toolParts(item.name).tool !== "lotus chat delegate") return null;
  return { type: str(input.model) ?? str(input.provider), description: str(input.title), delegated: true };
}

/** A sub-agent the agent ran on its own (D9): watched in the rail, never talked to. */
export interface NativeAgent {
  id: string;
  /** The Agent call it runs under, when a sub-agent started it; null at the thread's top. */
  parentId: string | null;
  type: string | null;
  description: string | null;
  status: ItemStatus;
}

/**
 * Claude's own Agent calls in a thread, in order. Lotus delegations are left out: they are threads.
 */
export function nativeAgents(state: ThreadState): NativeAgent[] {
  return state.turns.flatMap((turn) =>
    turn.items.flatMap(({ item }) => {
      const agent = subAgent(item);
      return agent && !agent.delegated
        ? [{ id: item.id, parentId: item.parentId ?? null, type: agent.type, description: agent.description, status: item.status }]
        : [];
    }),
  );
}

/**
 * One sub-agent's own conversation, as a thread of one turn: what its agent asked it, then its
 * steps and replies, with its sub-agents still nested under them. Null when the call is not in
 * `state`. Drawn read-only: a sub-agent is watched, never talked to (D9).
 */
export function subAgentState(state: ThreadState, agentId: string): ThreadState | null {
  const items = adoptLateSteps(state.turns).flatMap((turn) => turn.items);
  const call = items.find((e) => e.item.id === agentId);
  if (!call || !subAgent(call.item)) return null;
  const tree = new Set([agentId]);
  const own = items.flatMap((entry) => {
    if (!entry.item.parentId || !tree.has(entry.item.parentId)) return [];
    tree.add(entry.item.id);
    // Its own steps and replies are its top level; what its sub-agents did stays nested.
    return [entry.item.parentId === agentId ? { ...entry, item: { ...entry.item, parentId: undefined } } : entry];
  });
  const input = call.item.kind === "tool" ? ((call.item.input ?? {}) as Record<string, unknown>) : {};
  const prompt = str(input.prompt);
  // Its final report comes back as the Agent call's output, not as a message of its own. A
  // background call's output is only "Async agent launched…": its report arrives as messages.
  const report = call.item.kind === "tool" && input.run_in_background !== true ? str(call.item.output) : null;
  if (report && call.item.status === "completed") {
    own.push({ ...call, item: { id: `${agentId}:report`, kind: "agentMessage", status: "completed", text: report } });
  }
  const running = call.item.status === "running" || own.some((e) => e.item.status === "running");
  const turn: TurnState = {
    id: `${agentId}:sub-agent`,
    input: prompt ? { text: prompt, clientRequestId: agentId } : null,
    status: running ? "running" : "completed",
    error: null,
    usage: null,
    startedAt: call.startedAt,
    endedAt: running ? null : Math.max(call.endedAt ?? call.startedAt, ...own.map((e) => e.endedAt ?? e.startedAt)),
    items: own,
  };
  // The thread's own session end is not the sub-agent's to show.
  return { ...state, session: { ...state.session, ended: false, error: null }, turns: [turn], interactions: [], modelSwitches: [] };
}

/** `lotus_chat_wait`: how many agents it waited for (0 when it does not say); null for any other step. */
function agentWait(item: ThreadItem): number | null {
  if (item.kind !== "tool" || toolParts(item.name).tool !== "lotus chat wait") return null;
  const ids = ((item.input ?? {}) as Record<string, unknown>).chatIds;
  return Array.isArray(ids) ? ids.length : 0;
}

/**
 * An MCP tool name as a readable tool and its server: Claude's `mcp__notionApi__API-query-data-source`
 * and Codex's `notionApi · API-query-data-source` both give { tool: "query data source", source: "notion" }.
 * Any other name is the tool itself.
 */
export function toolParts(name: string): { tool: string; source: string | null } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^(\S+) · (.+)$/.exec(name);
  if (!m) return { tool: name, source: null };
  const tool = m[2].replace(/^api[-_]/i, "").replace(/[-_]+/g, " ").trim() || m[2];
  // "plugin_playwright_playwright" → "playwright", "claude_ai_Slack" → "slack", "notionApi" → "notion"
  const last = m[1].split("_").at(-1) ?? m[1];
  const source = (last.replace(/api$/i, "") || last).toLowerCase();
  return { tool, source };
}

// "Read 1 file, ran 1 command, edited 2 files". Declined steps count as "declined N".
export function summarizeSteps(steps: readonly WorkStep[]): string {
  const counts = new Map<string, number>();
  const add = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const { item, depth } of steps) {
    // What a sub-agent did is its own business; the card counts the agent once.
    if (depth > 0) continue;
    const agent = subAgent(item);
    if (agent) {
      add(agent.delegated ? "delegated" : "agent");
      continue;
    }
    // Collecting the agents is part of delegating them, and loading a deferred tool is part of
    // using it: neither is a tool of its own.
    if (agentWait(item) !== null || (item.kind === "tool" && item.name === "ToolSearch")) continue;
    if (item.status === "declined") {
      add("declined");
      continue;
    }
    switch (item.kind) {
      case "reasoning":
        add("thought");
        break;
      case "command":
        add("command");
        break;
      case "fileRead":
        add("read");
        break;
      case "fileChange":
        add(item.change === "create" ? "created" : "edited");
        break;
      case "search":
        add("search");
        break;
      default:
        add("tool");
    }
  }
  const phrases: Array<[string, (n: number) => string]> = [
    ["read", (n) => `read ${plural(n, "file")}`],
    ["search", (n) => `searched ${plural(n, "time")}`],
    ["command", (n) => `ran ${plural(n, "command")}`],
    ["created", (n) => `created ${plural(n, "file")}`],
    ["edited", (n) => `edited ${plural(n, "file")}`],
    ["tool", (n) => `used ${plural(n, "tool")}`],
    ["delegated", (n) => `delegated ${plural(n, "agent")}`],
    ["agent", (n) => `ran ${plural(n, "agent")}`],
    ["declined", (n) => `declined ${plural(n, "step")}`],
  ];
  const parts = phrases.filter(([key]) => counts.has(key)).map(([key, phrase]) => phrase(counts.get(key) ?? 0));
  if (parts.length === 0) return counts.has("thought") ? "Thought" : "Worked";
  const text = parts.join(", ");
  return text[0].toUpperCase() + text.slice(1);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0];
  return line.length < text.length ? `${line} …` : line;
}

function relativeToCwd(text: string, cwd: string | null): string {
  if (!cwd) return text;
  return text.split(`/private${cwd}/`).join("").split(`${cwd}/`).join("");
}

// Shows a path relative to the thread's folder. macOS reports temp folders both as /var/… and
// /private/var/…, so both spellings count as inside.
export function displayPath(path: string, cwd: string | null): string {
  if (!cwd) return path;
  for (const root of [cwd, `/private${cwd}`]) {
    if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  }
  return path;
}

// Rows are rebuilt on every event; this tells the UI which ones did not change, so only those
// re-render. The thread state is immutable, so an unchanged item or interaction keeps its object.
export function sameTimelineRow(a: TimelineRow, b: TimelineRow): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.id !== b.id) return false;
  switch (a.kind) {
    case "user":
      return a.text === (b as typeof a).text && a.attachments.length === (b as typeof a).attachments.length && a.edit === (b as typeof a).edit;
    case "assistant": {
      const other = b as typeof a;
      return (
        a.text === other.text &&
        a.streaming === other.streaming &&
        a.filesSince === other.filesSince &&
        a.turnEnd?.forkable === other.turnEnd?.forkable &&
        a.turnEnd?.endedAt === other.turnEnd?.endedAt
      );
    }
    case "work": {
      const other = b as typeof a;
      return (
        a.status === other.status &&
        a.endedAt === other.endedAt &&
        a.steps.length === other.steps.length &&
        a.steps.every((s, i) => s.item === other.steps[i].item && s.interaction === other.steps[i].interaction)
      );
    }
    case "approval":
      return a.interaction === (b as typeof a).interaction;
    case "notice":
      return a.text === (b as typeof a).text && a.tone === (b as typeof a).tone;
    case "gap":
      return a.at === (b as typeof a).at && a.afterMs === (b as typeof a).afterMs;
    case "fork": {
      const other = b as typeof a;
      return a.fromTitle === other.fromTitle && a.worktree === other.worktree && a.canMove === other.canMove;
    }
  }
}

/** "45 min", "17 hours", "3 days": how long the chat sat quiet. */
export function gapDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}
