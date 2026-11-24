"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, CalendarCheck2, CalendarClock, Compass, FolderGit2, GitPullRequest, Loader2, SlidersHorizontal, CircleX } from "lucide-react";
import { useMemo, useState } from "react";

import {
  EmptyState,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Pill,
  ResourceList,
  ResourceMenu,
  ResourceMeta,
  ResourceRow,
  ResourceSearch,
  ResourceToolbar,
  SkeletonRows,
  Switch,
  type MetaItem,
} from "@/components/resource/resource-kit";
import { GitHubMark, SlackMark } from "@/components/icons/ServiceMarks";

import type { Automation, AutomationClient, AutomationDraft, AutomationRun } from "../services/automation-api";
import {
  applyListView,
  DEFAULT_SORT,
  lastRunOf,
  rowNext,
  triggerOf,
  type ListView,
  type SortBy,
  type TriggerKind,
} from "../services/automation-list";
import { formatWhen } from "../services/format";
import { useSlackChannelNames } from "../hooks/useSlackChannelNames";
import { SIDEBAR_FILTER_FROM } from "./AutomationSidebar";

export function TriggerIcon({ kind, size = 16 }: { kind: TriggerKind; size?: number }) {
  if (kind === "schedule") return <CalendarClock size={size} strokeWidth={1.75} aria-hidden />;
  if (kind === "slack") return <SlackMark size={size - 2} />;
  if (kind === "github") return <GitHubMark size={size - 2} />;
  return <GitPullRequest size={size} strokeWidth={1.75} aria-hidden />;
}

/** Where an automation looks: its repositories, or the account it acts as. */
export function scopeOf(a: Automation): string | null {
  const repos = a.config?.repos ?? a.prompt?.repos ?? [];
  if (repos.length) {
    const shown = repos.map((r) => (r.endsWith("/*") ? r.slice(0, -2) : r));
    return shown.length > 2 ? `${shown.slice(0, 2).join(", ")} +${shown.length - 2}` : shown.join(", ");
  }
  return a.config?.account ?? a.prompt?.account ?? null;
}

export function metaOf(a: Automation, size = 13): MetaItem[] {
  const trigger = triggerOf(a);
  const items: MetaItem[] = [];
  const scope = scopeOf(a);
  if (scope) items.push({ icon: <FolderGit2 size={size} aria-hidden />, text: scope, title: "Repositories" });
  items.push({
    icon: <CalendarClock size={size} aria-hidden />,
    text: trigger.label,
    title: a.schedule ? `${a.schedule.cron} · ${a.schedule.timezone}` : undefined,
  });
  if (a.nextRunMs) items.push({ icon: <CalendarCheck2 size={size} aria-hidden />, text: `Next ${formatWhen(a.nextRunMs)}` });
  return items;
}

const STATUS_OPTIONS: { id: "on" | "off"; label: string }[] = [
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];
const TRIGGER_OPTIONS: { id: TriggerKind; label: string }[] = [
  { id: "schedule", label: "Schedule" },
  { id: "slack", label: "Slack" },
  { id: "github", label: "GitHub" },
  { id: "manual", label: "On demand" },
];
const SORT_OPTIONS: { id: SortBy; label: string }[] = [
  { id: "created", label: "Date created" },
  { id: "name", label: "Name" },
  { id: "next", label: "Next run" },
];

function flip<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function InstalledTab({
  automations,
  runs,
  drafts,
  loaded,
  client,
  onOpen,
  onBrowse,
  onDescribe,
  quiet = false,
}: {
  /**
   * The Dock (`.pen` 16c v2): one line per automation — name, then what it does next — with its
   * switch; off ones dimmed below a rule; no search or filters until there are enough to need them.
   */
  quiet?: boolean;
  automations: Automation[];
  runs: AutomationRun[];
  drafts: AutomationDraft[];
  loaded: boolean;
  client: AutomationClient;
  onOpen: (id: string) => void;
  onBrowse: () => void;
  onDescribe: () => void;
}) {
  const [view, setView] = useState<Required<Pick<ListView, "query" | "status" | "triggers" | "sort">>>({
    query: "",
    status: [],
    triggers: [],
    sort: DEFAULT_SORT,
  });
  const [toggleError, setToggleError] = useState<string | null>(null);
  const shown = useMemo(() => applyListView(automations, view), [automations, view]);
  const filtering = view.status.length + view.triggers.length > 0;
  const channels = useSlackChannelNames(client, quiet && automations.some((a) => a.triggerKind === "slack"));
  const tools = !quiet || automations.length >= SIDEBAR_FILTER_FROM;

  const pickSort = (by: SortBy) =>
    setView((v) => ({
      ...v,
      sort: v.sort.by === by ? { by, dir: v.sort.dir === "asc" ? "desc" : "asc" } : { by, dir: by === "created" ? "desc" : "asc" },
    }));

  if (!loaded) return <SkeletonRows label="Loading automations" />;

  if (automations.length === 0) {
    return (
      <EmptyState
        action={
          <span className="au-draft-actions">
            <button type="button" className="rs-button" onClick={onBrowse}>
              Browse examples
            </button>
            <button type="button" className="rs-button rs-button--primary" onClick={onDescribe}>
              Describe one
            </button>
          </span>
        }
      >
        <strong>No automations yet</strong>
        Tell an agent what should happen on its own, like a morning PR brief or reviews for PRs asked for in Slack.
        Lotus saves it switched off until you check it.
      </EmptyState>
    );
  }

  const toggle = (a: Automation) => (on: boolean) => {
    setToggleError(null);
    client.setEnabled(a.id, on).catch((e: unknown) => setToggleError(`Could not turn ${on ? "on" : "off"} “${a.name}”: ${String(e)}`));
  };

  return (
    <>
      {tools ? (
      <ResourceToolbar>
        <ResourceSearch value={view.query} onChange={(query) => setView((v) => ({ ...v, query }))} placeholder="Search automations" />
        <ResourceMenu label="Filter" active={filtering} trigger={<SlidersHorizontal size={15} aria-hidden />}>
          <MenuLabel>Status</MenuLabel>
          {STATUS_OPTIONS.map((o) => (
            <MenuItem key={o.id} keepOpen checked={view.status.includes(o.id)} onSelect={() => setView((v) => ({ ...v, status: flip(v.status, o.id) }))}>
              {o.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuLabel>Trigger</MenuLabel>
          {TRIGGER_OPTIONS.map((o) => (
            <MenuItem key={o.id} keepOpen checked={view.triggers.includes(o.id)} onSelect={() => setView((v) => ({ ...v, triggers: flip(v.triggers, o.id) }))}>
              {o.label}
            </MenuItem>
          ))}
          {filtering ? (
            <>
              <MenuSeparator />
              <MenuItem onSelect={() => setView((v) => ({ ...v, status: [], triggers: [] }))}>Clear filters</MenuItem>
            </>
          ) : null}
        </ResourceMenu>
        <ResourceMenu label="Sort" trigger={<ArrowUpDown size={15} aria-hidden />}>
          <MenuLabel>Sort by</MenuLabel>
          {SORT_OPTIONS.map((o) => (
            <MenuItem
              key={o.id}
              keepOpen
              icon={view.sort.by === o.id ? view.sort.dir === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} /> : <span />}
              onSelect={() => pickSort(o.id)}
            >
              {o.label}
            </MenuItem>
          ))}
        </ResourceMenu>
      </ResourceToolbar>
      ) : null}

      {toggleError ? (
        <p className="au-error" role="alert">
          {toggleError}
        </p>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState
          action={
            <button type="button" className="rs-button" onClick={() => setView((v) => ({ ...v, query: "", status: [], triggers: [] }))}>
              Clear search and filters
            </button>
          }
        >
          {view.query.trim() ? `No automations match “${view.query.trim()}”${filtering ? " with these filters" : ""}.` : "No automations match these filters."}
        </EmptyState>
      ) : quiet ? (
        <>
          <ul className="au-arows" aria-label="Automations">
            {shown.map((a, i) => (
              <QuietAutomationRow
                key={a.id}
                automation={a}
                firstOff={!a.enabled && (i === 0 || shown[i - 1].enabled)}
                next={rowNext(a, { lastRun: lastRunOf(a, runs), channelName: (id) => channels.get(id) })}
                pending={drafts.filter((d) => d.automationId === a.id && d.status === "pending").length}
                onOpen={() => onOpen(a.id)}
                onToggle={toggle(a)}
              />
            ))}
          </ul>
          <button type="button" className="au-arows-browse" onClick={onBrowse}>
            <Compass size={13} strokeWidth={1.75} aria-hidden />
            Browse examples
          </button>
        </>
      ) : (
        <ResourceList label="Automations">
          {shown.map((a) => (
            <AutomationRow
              key={a.id}
              automation={a}
              lastRun={lastRunOf(a, runs)}
              pending={drafts.filter((d) => d.automationId === a.id && d.status === "pending").length}
              onOpen={() => onOpen(a.id)}
              onToggle={toggle(a)}
            />
          ))}
        </ResourceList>
      )}
    </>
  );
}

function AutomationRow({
  automation: a,
  lastRun,
  pending,
  onOpen,
  onToggle,
}: {
  automation: Automation;
  lastRun: AutomationRun | null;
  pending: number;
  onOpen: () => void;
  onToggle: (on: boolean) => void;
}) {
  const kind = triggerOf(a).kind;
  const busy = lastRun?.status === "running" || lastRun?.status === "queued";
  const failed = lastRun?.status === "failed" || lastRun?.status === "interrupted";
  const leading = busy ? (
    <Loader2 size={16} className="rs-status rs-status--busy" aria-label="Running" />
  ) : failed ? (
    <CircleX size={16} className="rs-status rs-status--fail" aria-label="Last run failed" />
  ) : (
    <TriggerIcon kind={kind} />
  );
  return (
    <ResourceRow
      label={a.name}
      leading={leading}
      title={a.name}
      muted={!a.enabled}
      titleMeta={
        <>
          {pending > 0 ? <Pill tone="accent">{pending} to review</Pill> : null}
          {!a.enabled && failed ? <Pill tone="danger">Paused after failures</Pill> : null}
        </>
      }
      meta={<ResourceMeta items={metaOf(a)} />}
      onOpen={onOpen}
      trailing={<Switch checked={a.enabled} onChange={onToggle} label={a.enabled ? `Turn off ${a.name}` : `Turn on ${a.name}`} />}
    />
  );
}

function QuietAutomationRow({
  automation: a,
  firstOff,
  next,
  pending,
  onOpen,
  onToggle,
}: {
  automation: Automation;
  firstOff: boolean;
  next: ReturnType<typeof rowNext>;
  pending: number;
  onOpen: () => void;
  onToggle: (on: boolean) => void;
}) {
  const subId = `au-arow-${a.id}`;
  return (
    <li className="au-arow" data-off={a.enabled ? undefined : "true"} data-first-off={firstOff || undefined}>
      <button type="button" className="au-arow-open" aria-label={a.name} aria-describedby={subId} onClick={onOpen}>
        <span className="au-arow-name">{a.name}</span>
        <span className="au-arow-sub" id={subId}>
          {pending > 0 ? <span className="au-arow-wait">{`${pending} ${a.actionKind === "pr_review" ? "to review" : "waiting"}`} · </span> : null}
          <span className="au-arow-next" data-tone={next.tone}>{next.text}</span>
        </span>
      </button>
      <Switch checked={a.enabled} onChange={onToggle} label={a.enabled ? `Turn off ${a.name}` : `Turn on ${a.name}`} />
    </li>
  );
}
