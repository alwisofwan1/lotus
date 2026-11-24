"use client";

/**
 * The Fleet panel — every cell on the board, once (`plans/canvas-fleet-panel/` S2).
 *
 * Replaces three overlapping lists that used to share this column: a needs-you lane, an inbox
 * grouped by status bucket, and a Processes tree grouped by edges. An agent appeared in two of them
 * at the same time, so reading the panel meant reconciling two rows about one thing.
 *
 * The needs-you lane stays pinned above this component and keeps its own violet treatment
 * (`plans/honest-agent-status/` Slice 4); the section list deliberately omits the agents it holds,
 * which is what makes "once" true.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { Node } from "@xyflow/react";
import { EmptyState } from "@/components/resource/resource-kit";
import {
  Bot,
  Database,
  Globe,
  Hand,
  ListChecks,
  ListTodo,
  ScrollText,
  Sparkles,
  StickyNote,
  Terminal,
  Users,
  ShieldCheck,
  Pencil,
  X,
} from "lucide-react";
import {
  agentStatusRegistry,
  type AgentStatusRegistry,
  type AgentStatusSnapshot,
} from "../services/agent-status-registry";
import { agentHeadlineStore, type AgentHeadlineStore } from "../services/agent-headline-store";
import { fleetSections, type FleetRow } from "../services/canvas-fleet-sections";
import { isCanvasNavigatorType, type CanvasNavigatorType } from "../services/canvas-node-view";
import { resolveRunnerVisualIdentity } from "../services/runner-visual-identity";
import type { AgentNodeStatus } from "../types/canvas";
import {
  normalizeTerminalLabel,
  TERMINAL_LABEL_MAX_LENGTH,
} from "../services/terminal/terminal-node-identity";

/** Status → dot modifier. The same mapping the inbox used, so the colours do not shift under anyone. */
const DOT: Record<AgentNodeStatus, string> = {
  idle: "idle",
  connecting: "starting",
  running: "running",
  "needs-you": "needs-you",
  completed: "live",
  error: "failed",
  stalled: "stalled",
};

const TYPE_ICON: Record<CanvasNavigatorType, React.ReactNode> = {
  agent: <Bot size={12} aria-hidden />,
  critic: <ShieldCheck size={12} aria-hidden />,
  "human-gate": <Hand size={12} aria-hidden />,
  team: <Users size={12} aria-hidden />,
  task: <ListTodo size={12} aria-hidden />,
  context: <Database size={12} aria-hidden />,
  plan: <ListChecks size={12} aria-hidden />,
  terminal: <Terminal size={12} aria-hidden />,
  note: <StickyNote size={12} aria-hidden />,
  skills: <ScrollText size={12} aria-hidden />,
  skill: <Sparkles size={12} aria-hidden />,
  browser: <Globe size={12} aria-hidden />,
};

/**
 * How often a row's time-in-state is recomputed.
 *
 * The same 5s the needs-you lane uses, and for the same reason: the display reads in seconds and
 * then whole minutes, so it can sit a few seconds stale at worst, and a 1s tick would repaint the
 * whole rail sixty times a minute to move one digit nobody is watching that closely.
 */
export const FLEET_TICK_MS = 5_000;

interface Props {
  nodes: Node[];
  /**
   * Promote a row. The clicked button travels with it so the caller can blur it when the node's own
   * input turns out not to be focusable — a button left holding the keyboard swallows every keystroke.
   */
  onFocusNode: (nodeId: string, source?: HTMLElement | null) => void;
  onCloseNode: (nodeId: string) => void;
  /** Persist a canonical terminal label. Omitted on read-only Fleet projections. */
  onRenameNode?: (nodeId: string, label: string) => void;
  /** The current hero, so the rail can say which row you are looking at. */
  heroId?: string | null;
  /** Injected for tests. Production ticks the wall clock for the time-in-state suffix. */
  now?: () => number;
  /** Injected for tests; production uses the process-wide stores. */
  registry?: AgentStatusRegistry;
  headlines?: AgentHeadlineStore;
  /** Project-scoped scroll position restored when returning to this Fleet. */
  railScrollTop?: number;
  onRailScrollTopChange?: (scrollTop: number) => void;
  /** The empty board's one action. Absent: the empty line says so and offers nothing. */
  onAddTerminal?: () => void;
}

/**
 * The runner's own mark for an agent row, falling back to the node-type icon.
 *
 * Resolved from the live snapshot rather than the node's data, because that is where the Runner
 * Registry's answer lands — a custom Claude-family runner reports `custom` on the node but carries
 * its real label and family flag on the snapshot, and without them it would wear a generic glyph in
 * this panel while its own header shows the Claude logo.
 */
/**
 * The vendor brand a row should be coloured by, or undefined to fall back to the node-type colour.
 *
 * Only agent rows have a runner, and only a runner we recognise has a brand — an unknown custom CLI
 * returns `generic`, which is deliberately dropped here so the row keeps its node-type colour
 * rather than borrowing a vendor's.
 */
function brandFor(row: FleetRow, live: AgentStatusSnapshot | undefined): string | undefined {
  if (row.type !== "agent" || !live?.runner) return undefined;
  const { brand } = resolveRunnerVisualIdentity({
    runner: live.runner,
    customRunner: live.runnerLabel
      ? { id: "", name: live.runnerLabel, claudeFamily: !!live.claudeFamily }
      : null,
  });
  return brand === "generic" ? undefined : brand;
}

function RowMark({ row, live }: { row: FleetRow; live: AgentStatusSnapshot | undefined }) {
  if (row.type === "agent" && live?.runner) {
    const identity = resolveRunnerVisualIdentity({
      runner: live.runner,
      customRunner: live.runnerLabel
        ? { id: "", name: live.runnerLabel, claudeFamily: !!live.claudeFamily }
        : null,
    });
    if (identity.mark.kind === "logo") {
      // A MASK, not an <img>. The vendor logos are flat single-colour SVGs, and an <img> cannot be
      // tinted — `color` does not reach inside it — so the row could never show the runner's brand.
      // The persona badge already solved this the same way (agent-node-persona-nl.css,
      // `[data-mark="logo"]`); this is that trick applied to the list.
      return (
        <span
          className="canvas-fleet-logo"
          style={{ "--fleet-logo": `url(${identity.mark.src})` } as CSSProperties}
        />
      );
    }
  }
  return <>{TYPE_ICON[row.type]}</>;
}

export function CanvasFleetPanel({
  nodes,
  onFocusNode,
  onCloseNode,
  onRenameNode,
  heroId,
  now = Date.now,
  registry = agentStatusRegistry,
  headlines = agentHeadlineStore,
  railScrollTop = 0,
  onRailScrollTopChange,
  onAddTerminal,
}: Props) {
  const [live, setLive] = useState<AgentStatusSnapshot[]>(() => registry.list());
  const [rename, setRename] = useState<{ id: string; draft: string; error: string | null } | null>(null);
  useEffect(() => registry.subscribe(setLive), [registry]);

  // Subscribed for the re-render, not the value: a headline changing must reach these rows, and the
  // store's version advancing is what delivers it. It only advances when a DISPLAYED line changed.
  useSyncExternalStore(
    (onChange) => headlines.subscribe(onChange),
    () => headlines.version(),
    () => 0,
  );

  // Held in state rather than read during render: reading the clock inline makes the output depend
  // on when the render ran (`react-hooks/purity` catches exactly that), and it also moved the
  // durations on renders that had nothing to do with time passing.
  const [tick, setTick] = useState(() => now());
  useEffect(() => {
    const id = setInterval(() => setTick(now()), FLEET_TICK_MS);
    return () => clearInterval(id);
  }, [now]);

  const sections = fleetSections(nodes, live, (id) => headlines.get(id), tick);
  const liveById = new Map(live.map((snapshot) => [snapshot.id, snapshot]));
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scrollRef.current;
    if (element && element.scrollTop !== railScrollTop) element.scrollTop = railScrollTop;
  }, [railScrollTop]);

  // ── The beat ────────────────────────────────────────────────────────────────────────────────
  //
  // One pass of the travelling segment each time a row's DISPLAYED line actually changes, which is
  // the panel's only honest "this agent just did something". Deliberately not a loop and not a
  // timer: a loop makes a hung agent sweep as cheerfully as a working one, which is exactly the
  // reading error the rail used to have.
  //
  // The signal costs nothing new. `agentHeadlineStore` already suppresses everything that is not a
  // visible change — same tool, same area, mid-turn flips — and only then advances its version, so
  // comparing the rendered line is the same event, read where it is already available.
  const beatFor = useRef(new Map<string, string>());
  const beatTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [beating, setBeating] = useState<ReadonlySet<string>>(() => new Set());

  // No dependency array on purpose: the comparison IS the guard. `sections` is rebuilt on every
  // render, so a dependency on it would fire every time anyway while pretending otherwise.
  useEffect(() => {
    const started: string[] = [];
    for (const section of sections) {
      for (const row of section.rows) {
        // Only the headline slot. An identity line (a cwd, a model name) is not an agent speaking,
        // and pulsing on it would make renaming a pane look like work.
        if (row.detailKind !== "ask") continue;
        const line = row.detail ?? "";
        const previous = beatFor.current.get(row.id);
        beatFor.current.set(row.id, line);
        // A first sighting is not a change. Without this every row beats the moment the panel
        // opens, which reads as the whole fleet starting at once.
        if (previous !== undefined && previous !== line && line) started.push(row.id);
      }
    }
    if (started.length === 0) return;
    setBeating((current) => {
      const next = new Set(current);
      for (const id of started) next.add(id);
      return next;
    });
    for (const id of started) {
      clearTimeout(beatTimers.current.get(id));
      beatTimers.current.set(
        id,
        // Matches the animation's own length. Held any longer and a fast agent's next beat would
        // find the attribute already set, and the animation would not restart.
        setTimeout(() => {
          beatTimers.current.delete(id);
          setBeating((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }, 1_000),
      );
    }
  });

  useEffect(() => {
    const timers = beatTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);
  // Every cell, including the blocked ones pinned above — the count answers "how much is on this
  // board", not "how many rows are below this line".
  const total = nodes.filter((node) => isCanvasNavigatorType(node.type)).length;

  return (
    <div className="canvas-fleet">
      <div className="canvas-fleet-header">
        <span className="canvas-fleet-title">Fleet</span>
        <span className="canvas-fleet-count" data-testid="fleet-count">{total}</span>
      </div>

      {total === 0 ? (
        <div className="canvas-fleet-empty" data-testid="fleet-empty">
          <EmptyState action={onAddTerminal ? <button type="button" className="rs-button rs-button--primary" onClick={onAddTerminal}>New terminal</button> : null}>
            Nothing on this canvas yet.
          </EmptyState>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="canvas-fleet-scroll"
          onScroll={(event) => onRailScrollTopChange?.(event.currentTarget.scrollTop)}
        >
          {sections.map((section) => (
            <section key={section.id} className="canvas-fleet-section">
              {/* A board of nothing but agents does not need to be told they are agents. The
                  heading earns its line only when there is another band to tell it apart from —
                  and on this rail the first line is the most valuable one. */}
              {sections.length > 1 && (
                <div className="canvas-fleet-section-title">{section.title}</div>
              )}
              {section.rows.map((row) => (
                <div
                  key={row.id}
                  className="canvas-fleet-row"
                  // Carries the node type into CSS so .canvas-fleet-mark can paint the icon in
                  // that type's identity colour — the same one the node wears on the board.
                  data-type={row.type}
                  // …and the runner's VENDOR, which outranks the type colour for agent rows: two
                  // agents are the same node type but not the same tool, and the logo already says
                  // so. `generic` (an unknown custom CLI) is omitted so the type colour stands.
                  data-brand={brandFor(row, liveById.get(row.id))}
                  // Drives the status stripe on the row's left edge. On the element rather than
                  // the button because the hero marker lives here too, and one element owning
                  // both keeps them from drawing two bars side by side.
                  data-status={row.status}
                  // The rail never said which cell you were actually looking at. On a list where
                  // every row is a jump target, the one you are already on is the most useful thing
                  // to mark.
                  data-hero={row.id === heroId ? "true" : undefined}
                  // Set for one animation length when this row's headline changes. The travelling
                  // segment runs once per beat rather than looping, so a row that has stopped
                  // producing is visibly still while its status still reads `running`.
                  data-beat={beating.has(row.id) ? "true" : undefined}
                >
                  {/* The status edge, and inside it the segment that travels on a beat. An element
                      rather than a pseudo because the traveller has to be clipped by the 1px edge,
                      and clipping it against the row instead would need `overflow: hidden` there —
                      which would eat the focus ring the button draws outside itself. */}
                  <span className="canvas-fleet-edge" aria-hidden>
                    <span />
                  </span>
                  {rename?.id === row.id ? (
                    <form
                      className="canvas-fleet-rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const next = normalizeTerminalLabel(rename.draft);
                        if (!next) {
                          setRename({ ...rename, error: "Enter a terminal name" });
                          return;
                        }
                        onRenameNode?.(row.id, next);
                        setRename(null);
                      }}
                    >
                      <span className="canvas-fleet-mark" aria-hidden>
                        <RowMark row={row} live={liveById.get(row.id)} />
                      </span>
                      <input
                        autoFocus
                        className="canvas-fleet-rename-input"
                        aria-label="Terminal name"
                        aria-invalid={rename.error ? true : undefined}
                        title={rename.error ?? undefined}
                        value={rename.draft}
                        maxLength={TERMINAL_LABEL_MAX_LENGTH}
                        spellCheck={false}
                        onChange={(event) => setRename({ id: row.id, draft: event.target.value, error: null })}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setRename(null);
                          }
                        }}
                      />
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="canvas-fleet-focus"
                      aria-label={`Focus ${row.label}`}
                      // One title for the row, not one per line: every line ellipsizes in a column
                      // this narrow, and overlapping tooltips would fight over the same hover. The
                      // hover is where the full text lives, so it carries all three.
                      title={[row.label, row.detail, row.state].filter(Boolean).join(" — ")}
                      onClick={(event) => onFocusNode(row.id, event.currentTarget)}
                    >
                      <span className="canvas-fleet-mark" aria-hidden>
                        <RowMark row={row} live={liveById.get(row.id)} />
                      </span>
                      <span className="canvas-fleet-body">
                        <span className="canvas-fleet-name">{row.label}</span>
                        {row.detail && (
                          <span
                            className="canvas-fleet-detail"
                            // Styled by kind: an instruction and an identity are different facts, and
                            // a cwd must not read as something the operator asked for.
                            data-kind={row.detailKind}
                            data-testid={`fleet-detail-${row.id}`}
                          >
                            {row.detail}
                          </span>
                        )}
                        {/* What it is doing, on its own line under what it is for.
                            These used to share the slot above and take turns: a headline hid the
                            status, and a status hid everything the row knew about itself. A cell with
                            no live state — a note, a plan — simply has no third line. */}
                        {row.state && (
                          <span className="canvas-fleet-state" data-testid={`fleet-state-${row.id}`}>
                            {row.state}
                          </span>
                        )}
                      </span>
                      {/* Every row keeps its dot, the hero included. A "FOCUS" word here said what the
                          row's own lift, brighter name and inset bar already say — and it cost the
                          hero the one signal the rest of the list has: whether it is working. */}
                      {row.status && (
                        <span
                          className={`cth-dot cth-dot--${DOT[row.status]}`}
                          data-testid={`fleet-dot-${row.id}`}
                          aria-hidden
                        />
                      )}
                    </button>
                  )}
                  {row.type === "terminal" && onRenameNode && rename?.id !== row.id ? (
                    <button
                      type="button"
                      className="canvas-fleet-rename-action"
                      aria-label={`Rename ${row.label}`}
                      onClick={() => setRename({ id: row.id, draft: row.label, error: null })}
                    >
                      <Pencil size={10} aria-hidden />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="canvas-fleet-close"
                    aria-label={`Close ${row.label}`}
                    onClick={() => onCloseNode(row.id)}
                  >
                    <X size={11} aria-hidden />
                  </button>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
