"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  EmptyState,
  ResourceList,
  ResourceRow,
  ResourceTabs,
  SkeletonRows,
} from "@/components/resource/resource-kit";
import type { FactoryRunsHandle } from "../hooks/useFactoryRuns";
import { factoryRefLabel } from "../services/factory-run";
import {
  factoryRepoCounts,
  factoryRowKey,
  factoryRunElapsedMs,
  formatElapsed,
  groupFactoryRuns,
  type FactoryGroupId,
  type FactoryRunRow,
} from "../services/factory-run-list";
import { FACTORY_WAITING_LINE, factoryProgressLine } from "../services/factory-progress";
import { factoryBoardColumns, factoryCardLine, factoryPrChip, factoryRowAction } from "../services/factory-board";
import { FactoryStageBar } from "./FactoryStageBar";
import { FactoryNewRunSheet } from "./FactoryNewRunSheet";
import type { FactoryNewRunSource } from "../services/factory-new-run";
import { FactoryRunDetailPane, type FactoryRunActions } from "./FactoryRunDetailPane";
import { FactorySplit, useEscape } from "./FactorySplit";
import { FactoryRepoSelect } from "./FactoryRepoSelect";
import { FactoryAgentsView } from "./FactoryAgentsView";
import { FactoryChiefPane, useFactoryChiefLine } from "./FactoryChiefOfStaff";
import { DitherPixels, EmptyDither } from "./FactoryDither";
import {
  factoryAcceptSpecChange,
  factoryDeclineSpecChange,
  factoryEditDraft,
  factorySendAll,
  factorySetSlackIdentity,
  factorySendDraft,
  factorySetFeedbackLabel,
  factoryStartRound,
} from "@/lib/tauri/graph-run";
import { factoryChiefInbox, factoryPrsInReview } from "../services/factory-chief";
import type { FactoryAgentsSource } from "../services/factory-agents";
import "@/styles/factory.css";

export type FactoryTab = "runs" | "board" | "chief" | "agents" | "insights";
type Runs = Pick<FactoryRunsHandle, "rows" | "groups" | "loading" | "error">;

const TABS = [
  { id: "runs", label: "Runs" },
  { id: "board", label: "Board" },
  { id: "chief", label: "Chief of Staff" },
  // Preserve the persisted `agents` key while presenting the broader settings responsibility.
  { id: "agents", label: "Settings" },
] as const;

/** A run is opened by its issue, not its id: Try again makes a new run and the pane follows it. */
const issueKey = factoryRowKey;

/**
 * The Factory page: every run in groups, so one glance says which need you, and the opened run
 * beside them; or the same runs as cards on a board, by where each one is. Settings keeps the
 * persisted agents key; legacy Insights selections resolve to Runs. `now` is injectable for tests;
 * live, it ticks once a second while a run is working — a display
 * clock, not a read of any data. Without `actions` the rows only list. The tab is the caller's to
 * keep when it passes `tab`, so the panel reopens on the same view.
 */
export function FactorySurface({
  runs,
  now,
  onClose,
  actions,
  tab: tabProp,
  onTabChange,
  focusKey,
  newRun,
  newRunRequest,
  agents,
  chiefCheckedAt,
  onOpenTasks,
}: {
  runs: Runs;
  now?: number;
  onClose?: () => void;
  actions?: FactoryRunActions;
  tab?: FactoryTab;
  onTabChange?: (tab: FactoryTab) => void;
  /** The run to open, by `factoryWorkflowId(repo, issue)`: the issue panel's "Open in Factory". */
  focusKey?: string | null;
  /** Where New run reads issues and starts runs; without it there is no New run. */
  newRun?: FactoryNewRunSource;
  /** A caller's "open New run" (the canvas ⌘K): each new non-zero value opens the sheet once. */
  newRunRequest?: number;
  /** Where the Agents tab reads and saves each repo's factory definition (FI5). */
  agents?: FactoryAgentsSource;
  /** When the Chief of Staff last looked (Unix ms); null before its first look. Absent: no strip. */
  chiefCheckedAt?: number | null;
  /** Opens Tasks, where runs start from tickets: the way out of an empty Factory without New run. */
  onOpenTasks?: () => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  // Adjusted while rendering, like focusKey below: a request made before mount opens on mount.
  const [seenNewRun, setSeenNewRun] = useState(0);
  if (newRunRequest && newRunRequest !== seenNewRun) {
    setSeenNewRun(newRunRequest);
    if (newRun) setSheetOpen(true);
  }
  const [ownTab, setOwnTab] = useState<FactoryTab>("runs");
  const requestedTab = tabProp ?? ownTab;
  const tab = requestedTab === "insights" ? "runs" : requestedTab;
  const setTab = (next: FactoryTab) => {
    setOwnTab(next);
    onTabChange?.(next);
  };
  // Runs and Board each keep their own repo filter (#167). A kept repo with no runs now shows all.
  // A run focused at mount counts as opened: a kept repo that hides it is let go (idempotent).
  const [repoFilter, setRepoFilter] = useState<Record<ListTab, string | null>>(() => {
    const focused = focusKey ? runs.rows.find((row) => issueKey(row) === focusKey)?.repo : undefined;
    const kept = (list: ListTab) => {
      const repo = keptRepoFilter(list);
      if (!focused || !repo || repo === focused) return repo;
      keepRepoFilter(list, null);
      return null;
    };
    return { runs: kept("runs"), board: kept("board") };
  });
  const setListRepo = (list: ListTab, repo: string | null) => {
    setRepoFilter((current) => ({ ...current, [list]: repo }));
    keepRepoFilter(list, repo);
  };
  const [openKey, setOpenKey] = useState<string | null>(focusKey ?? null);
  // Opening a run the repo filter hides shows all repos again, so its row is in the list.
  const openRun = (key: string) => {
    setOpenKey(key);
    const repo = runs.rows.find((row) => issueKey(row) === key)?.repo;
    for (const list of LIST_TABS) {
      if (repo && repoFilter[list] && repoFilter[list] !== repo) setListRepo(list, null);
    }
  };
  // A new focus opens its run; adjusted while rendering, so the pane never shows the old one first.
  const [seenFocus, setSeenFocus] = useState(focusKey);
  if (focusKey !== seenFocus) {
    setSeenFocus(focusKey);
    if (focusKey) openRun(focusKey);
  }
  const repos = factoryRepoCounts(runs.rows);
  const listTab = isListTab(tab) ? tab : null;
  const kept = listTab ? repoFilter[listTab] : null;
  const repo = kept && repos.some((r) => r.repo === kept) ? kept : null;
  const repoRows = repo ? runs.rows.filter((row) => row.repo === repo) : null;
  const shown: Runs = repoRows ? { ...runs, rows: repoRows, groups: groupFactoryRuns(repoRows) } : runs;
  const pickRepo = (value: string) => {
    if (listTab) setListRepo(listTab, value || null);
  };
  const repoPicker =
    repos.length > 1 ? (
      <FactoryRepoSelect
        label="Filter by repo"
        value={repo ?? ""}
        options={[{ value: "", label: `All repos · ${runs.rows.length}` }, ...repos.map((r) => ({ value: r.repo, label: `${r.repo} · ${r.count}` }))]}
        onChange={pickRepo}
      />
    ) : null;
  const anyWorking = runs.rows.some((row) => row.group === "working");
  const clock = useClock(anyWorking && now === undefined);
  const at = now ?? clock;
  const opened = actions && openKey ? (runs.rows.find((row) => issueKey(row) === openKey) ?? null) : null;
  useEscape(Boolean(opened) && !sheetOpen, () => setOpenKey(null));
  const chiefInbox = factoryChiefInbox(runs.rows);
  // The Chief of Staff lives on its tab: the count asks for you, the line says when it last looked.
  const chiefLine = useFactoryChiefLine(chiefInbox.needsYou.length, factoryPrsInReview(runs.rows), chiefCheckedAt, now);
  const tabs = TABS.map((t) =>
    t.id === "chief" && chiefLine !== null
      ? { ...t, count: chiefInbox.needsYou.length, tone: "attention" as const, hint: chiefLine }
      : { ...t },
  );

  return (
    <div className="ws-body fa-body">
      <div className="ws-column fa-column rs-surface">
        <header className="fa-head">
          <span className="fa-head-mark" aria-hidden>
            <DitherPixels status="done" pixel={2} />
          </span>
          <h1 className="fa-head-title">Factory</h1>
          <div className="fa-head-tabs">
            <ResourceTabs tabs={tabs} value={tab} onChange={setTab} label="Factory views" />
          </div>
          <span className="fa-head-gap" />
          {newRun ? (
            <button type="button" className="rs-button rs-button--primary fa-head-new" onClick={() => setSheetOpen(true)}>
              <Plus size={14} strokeWidth={1.75} aria-hidden />
              New run
            </button>
          ) : null}
          {onClose ? (
            <button type="button" className="rs-icon-button" onClick={onClose} aria-label="Close factory" title="Close">
              <X size={15} strokeWidth={1.75} aria-hidden />
            </button>
          ) : null}
        </header>
        {tab === "runs" || tab === "board" ? (
          <FactorySplit tab={tab} open={Boolean(opened)}>
            <div className="rs-scroll">
              <div className={tab === "runs" ? "rs-band" : "fa-board-band"}>
                {tab === "runs" ? (
                  <RunsView
                    runs={shown}
                    repoPicker={repoPicker}
                    now={at}
                    openKey={opened ? openKey : null}
                    onOpen={actions ? openRun : undefined}
                    onNewRun={newRun ? () => setSheetOpen(true) : undefined}
                    onOpenTasks={onOpenTasks}
                  />
                ) : (
                  <BoardView runs={shown} repoPicker={repoPicker} now={at} openKey={opened ? openKey : null} onOpen={actions ? openRun : undefined} />
                )}
              </div>
            </div>
            {opened && actions ? (
              <aside className="rs-scroll fa-detail-pane" aria-label="Run detail">
                <FactoryRunDetailPane row={opened} now={at} actions={actions} onClose={() => setOpenKey(null)} />
              </aside>
            ) : null}
          </FactorySplit>
        ) : tab === "chief" ? (
          <div className="rs-scroll">
            <div className="rs-band">
              <FactoryChiefPane
                inbox={chiefInbox}
                focusKey={tab === "chief" ? focusKey : undefined}
                actions={actions}
                onOpenRun={
                  actions
                    ? (key) => {
                        setTab("runs");
                        openRun(key);
                      }
                    : undefined
                }
                onOpenWorktree={actions?.openWorktree}
                onSetFeedbackLabel={actions ? factorySetFeedbackLabel : undefined}
                onStartRound={actions ? factoryStartRound : undefined}
                onAcceptSpecChange={actions ? factoryAcceptSpecChange : undefined}
                onDeclineSpecChange={actions ? factoryDeclineSpecChange : undefined}
                onEditDraft={actions ? factoryEditDraft : undefined}
                onSendDraft={actions ? factorySendDraft : undefined}
                onSendAll={actions ? factorySendAll : undefined}
                onSetSlackIdentity={actions ? factorySetSlackIdentity : undefined}
                now={at}
              />
            </div>
          </div>
        ) : tab === "agents" ? (
          agents ? (
            <FactoryAgentsView source={agents} />
          ) : (
            <div className="rs-scroll">
              <div className="rs-band">
                <EmptyState art={<EmptyDither />} action={onOpenTasks ? <button type="button" className="rs-button" onClick={onOpenTasks}>Open Tasks</button> : null}>
                  Add a GitHub ticket source in Tasks to set up a factory.
                </EmptyState>
              </div>
            </div>
          )
        ) : (
          <div className="rs-scroll">
            <div className="rs-band">
              <EmptyState art={<EmptyDither />}>Coming soon.</EmptyState>
            </div>
          </div>
        )}
      </div>
      {sheetOpen && newRun ? <FactoryNewRunSheet source={newRun} rows={runs.rows} onClose={() => setSheetOpen(false)} /> : null}
    </div>
  );
}

function RunsView({
  runs,
  now,
  openKey,
  onOpen,
  onNewRun,
  onOpenTasks,
  repoPicker,
}: {
  runs: Runs;
  now: number;
  openKey: string | null;
  onOpen?: (key: string) => void;
  onNewRun?: () => void;
  onOpenTasks?: () => void;
  repoPicker?: ReactNode;
}) {
  // Done is history, not work: closed until asked for, so the groups that need a look stay on top.
  const [doneOpen, setDoneOpen] = useState(false);
  // A chip narrows the list to one group; pressing it again shows every group.
  const [chosenGroup, setOnly] = useState<FactoryGroupId | null>(null);
  if (runs.loading) return <SkeletonRows label="Loading runs" />;
  const only = liveGroup(chosenGroup, runs.groups);

  // ↑↓ walk every row, across groups; Enter opens the focused one. Focus is the cursor.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onOpen) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button.rs-row-open")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(at + 1, buttons.length - 1) : Math.max(at - 1, 0);
      buttons[next].focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const key = buttons[at].querySelector<HTMLElement>("[data-run-key]")?.dataset.runKey;
      if (key) onOpen(key);
    }
  };

  return (
    <div className="fa-runs" onKeyDown={onKeyDown}>
      {runs.error ? (
        <p role="alert" className="rs-description">
          Could not refresh the runs: {runs.error}
        </p>
      ) : null}
      <FilterBar repoPicker={repoPicker} groups={runs.groups} only={only} onChange={setOnly} />
      {runs.groups.length === 0 ? (
        <EmptyState
          art={<EmptyDither />}
          action={
            onNewRun ? (
              <button type="button" className="rs-button rs-button--primary" onClick={onNewRun}>
                Start your first run
              </button>
            ) : onOpenTasks ? (
              <button type="button" className="rs-button" onClick={onOpenTasks}>
                Open Tasks
              </button>
            ) : null
          }
        >
          No Factory runs yet. Start one from a GitHub issue or a Notion ticket.
        </EmptyState>
      ) : (
        runs.groups.filter((group) => only === null || group.id === only).map((group) => {
          const collapsed = group.id === "done" && !doneOpen && only !== "done";
          return (
            <section key={group.id}>
              <h2 className="fa-group-label" data-group={group.id}>
                {group.id === "done" ? (
                  <button type="button" className="fa-group-toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>
                    {group.label} · {group.rows.length}
                  </button>
                ) : (
                  group.label
                )}
              </h2>
              {collapsed ? null : (
                <ResourceList label={group.label}>
                  {group.rows.map((row) => (
                    <FactoryRunListRow key={row.id} row={row} now={now} open={issueKey(row) === openKey} onOpen={onOpen} />
                  ))}
                </ResourceList>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}

function FactoryRunListRow({ row, now, open, onOpen }: { row: FactoryRunRow; now: number; open: boolean; onOpen?: (key: string) => void }) {
  const key = issueKey(row);
  const line = factoryProgressLine(row.progress) ?? (row.state === "running" ? FACTORY_WAITING_LINE : null);
  const action = onOpen ? factoryRowAction(row.state) : null;
  return (
    <ResourceRow
      label={`${factoryRefLabel(row.issue)} ${row.title}`}
      leading={<span className="fa-glyph" data-group={row.group} aria-hidden />}
      title={
        <span className="fa-row-title" data-run-key={key} data-open={open ? "true" : undefined}>
          {factoryRefLabel(row.issue)} {row.title}
        </span>
      }
      meta={
        <>
          {row.progress && (row.group === "working" || row.group === "needs-you") ? (
            <span className="fa-row-bar">
              <FactoryStageBar progress={row.progress} state={row.state} pixel={2} rows={2} />
            </span>
          ) : null}
          <span className="fa-row-line" data-group={row.group}>
            {[
              row.group === "needs-you" || row.state === "done" || row.state === "merged" || row.state === "pr-closed" ? factoryCardLine(row) : row.group === "working" ? line : null,
              row.repo,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </>
      }
      trailing={
        <span className="fa-row-end">
          {action ? (
            <button type="button" className="rs-button fa-row-action" data-group={row.group} onClick={() => onOpen!(key)}>
              {action}
            </button>
          ) : null}
          <span className="fa-time">{formatElapsed(factoryRunElapsedMs(row, now))}</span>
          {row.spentUsd !== null ? <span className="fa-row-cost">${row.spentUsd.toFixed(2)}</span> : null}
        </span>
      }
      onOpen={onOpen ? () => onOpen(key) : undefined}
    />
  );
}

/** The repo filter beside the group chips; nothing when neither has a choice to offer. */
function FilterBar({ repoPicker, ...chips }: { repoPicker?: ReactNode } & Parameters<typeof FilterChips>[0]) {
  if (!repoPicker && chips.groups.length <= 1) return null;
  return (
    <div className="fa-filter-bar">
      {repoPicker}
      <FilterChips {...chips} />
    </div>
  );
}

/** A chosen group chip the list no longer has (another repo picked) lets go, so the list never goes blank. */
function liveGroup(chosen: FactoryGroupId | null, groups: Runs["groups"]): FactoryGroupId | null {
  return chosen && groups.some((group) => group.id === chosen) ? chosen : null;
}

/** The tabs that list runs, each with its own repo filter (#167). */
type ListTab = "runs" | "board";
const LIST_TABS: readonly ListTab[] = ["runs", "board"];
const isListTab = (tab: FactoryTab): tab is ListTab => (LIST_TABS as readonly string[]).includes(tab);

/** Each list tab's repo filter, kept across restarts; storage that fails only forgets it. */
const repoFilterKey = (tab: ListTab) => `lotus.factory.repo-filter.${tab}`;
function keptRepoFilter(tab: ListTab): string | null {
  try {
    return window.localStorage.getItem(repoFilterKey(tab));
  } catch {
    return null;
  }
}
function keepRepoFilter(tab: ListTab, repo: string | null) {
  try {
    if (repo) window.localStorage.setItem(repoFilterKey(tab), repo);
    else window.localStorage.removeItem(repoFilterKey(tab));
  } catch {
    // Private window or blocked storage: the filter holds until the page closes.
  }
}

function FilterChips({ groups, only, onChange }: { groups: Runs["groups"]; only: FactoryGroupId | null; onChange: (id: FactoryGroupId | null) => void }) {
  if (groups.length <= 1) return null;
  return (
    <div className="fa-chips" role="group" aria-label="Show">
      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          className="fa-filter-chip"
          data-group={group.id}
          aria-pressed={only === group.id}
          onClick={() => onChange(only === group.id ? null : group.id)}
        >
          <span className="fa-glyph" data-group={group.id} aria-hidden />
          {group.label}
          <span className="fa-chip-count">{group.rows.length}</span>
        </button>
      ))}
    </div>
  );
}

function BoardView({
  runs,
  now,
  openKey,
  onOpen,
  repoPicker,
}: {
  runs: Runs;
  now: number;
  openKey: string | null;
  onOpen?: (key: string) => void;
  repoPicker?: ReactNode;
}) {
  // Done is history: folded to a rail until asked for. An empty column is a rail too, so no column is a void.
  const [doneOpen, setDoneOpen] = useState(false);
  const [chosenGroup, setOnly] = useState<FactoryGroupId | null>(null);
  if (runs.loading) return <SkeletonRows label="Loading runs" />;
  const only = liveGroup(chosenGroup, runs.groups);
  const rows = only === null ? runs.rows : runs.rows.filter((row) => row.group === only);
  return (
    <div className="fa-board">
      {runs.error ? (
        <p role="alert" className="rs-description">
          Could not refresh the runs: {runs.error}
        </p>
      ) : null}
      <FilterBar repoPicker={repoPicker} groups={runs.groups} only={only} onChange={setOnly} />
      <div className="fa-columns">
        {factoryBoardColumns(rows).map((column) => {
          const folded = column.rows.length === 0 || (column.id === "done" && !doneOpen && only !== "done");
          if (folded) {
            const body = (
              <>
                <span className="fa-col-label">
                  {column.label}
                  <span className="fa-col-count">{column.rows.length}</span>
                </span>
                <span className="fa-rail-hint">{column.rows.length === 0 ? "Nothing here" : "Show"}</span>
              </>
            );
            return column.rows.length === 0 ? (
              <div key={column.id} className="fa-col fa-rail" data-column={column.id}>
                {body}
              </div>
            ) : (
              <button key={column.id} type="button" className="fa-col fa-rail" data-column={column.id} aria-expanded={false} onClick={() => setDoneOpen(true)}>
                {body}
              </button>
            );
          }
          return (
            <section key={column.id} className="fa-col" data-column={column.id}>
              <h2 className="fa-col-label">
                {column.id === "done" ? (
                  <button type="button" className="fa-group-toggle" aria-expanded onClick={() => setDoneOpen(false)}>
                    {column.label}
                  </button>
                ) : (
                  column.label
                )}
                <span className="fa-col-count">{column.rows.length}</span>
              </h2>
              <ul className="fa-cards" aria-label={column.label}>
                {column.rows.map((row) => (
                  <FactoryCard key={row.id} row={row} now={now} column={column.id} open={issueKey(row) === openKey} onOpen={onOpen} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function FactoryCard({
  row,
  now,
  column,
  open,
  onOpen,
}: {
  row: FactoryRunRow;
  now: number;
  column: string;
  open: boolean;
  onOpen?: (key: string) => void;
}) {
  const key = issueKey(row);
  const label = `${factoryRefLabel(row.issue)} ${row.title}`;
  const cost = row.spentUsd !== null ? ` · $${row.spentUsd.toFixed(2)}` : "";
  const verb = factoryRowAction(row.state) ?? (column === "ready" && row.prUrl ? "Review PR" : null);
  const prChip = factoryPrChip(row);
  return (
    <li className="fa-card" aria-label={label} data-column={column} data-open={open ? "true" : undefined}>
      {row.repo ? <p className="fa-card-repo">{row.repo}</p> : null}
      {onOpen ? (
        <button type="button" className="fa-card-title" onClick={() => onOpen(key)}>
          {label}
        </button>
      ) : (
        <span className="fa-card-title">{label}</span>
      )}
      <FactoryStageBar progress={row.progress} state={row.state} pixel={4} />
      <p className="fa-card-line">{factoryCardLine(row)}</p>
      <div className="fa-card-foot">
        <span className="fa-card-meta">
          <span className="fa-time">{formatElapsed(factoryRunElapsedMs(row, now))}</span>
          {cost}
        </span>
        {prChip ? <span className="fa-chip fa-card-chip">{prChip}</span> : null}
        {verb && onOpen ? (
          <button type="button" className="rs-button fa-card-action" data-column={column} onClick={() => onOpen(key)}>
            {verb}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
