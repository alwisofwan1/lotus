"use client";

import { useEffect, useState } from "react";
import {
  BookOpen,
  Brain,
  ChevronDown,
  FileCheck,
  FileText,
  GitPullRequest,
  Globe,
  type LucideIcon,
  Search,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react";

import { StatusIcon } from "@/components/resource/resource-kit";

import { useRunSteps } from "../hooks/useRunSteps";
import type { Automation, AutomationClient, AutomationProject, AutomationRun, RunStep } from "../services/automation-api";
import { formatWhen } from "../services/format";
import { formatElapsed, rowTime, stepKind, traceRows, type StepKind } from "../services/run-trace";
import { DitherOrb, DitherStrip } from "./RunDither";

/** What a run is about, from its key: the PR (`owner/repo#7`), or how a prompt run started. */
export function runSubject(run: AutomationRun): string {
  if (run.key.startsWith("schedule@")) return "Scheduled";
  if (run.key.startsWith("manual@")) return "Run now";
  // `answer@<ask id>`, and `#n` for each "Send again" (`ask.rs` `follow_up_key`).
  if (run.key.startsWith("answer@")) return "Follow-up";
  // `message@<run id>:<key>` (`chat.rs` `send_message`).
  if (run.key.startsWith("message@")) return "Your message";
  return run.key.replace(/@[0-9a-f]{7,}(~[0-9a-f-]+)?$/, "");
}

export const isBusy = (run: AutomationRun) => run.status === "running" || run.status === "queued";

/** How long a run that just finished keeps its card, so the end is seen rather than a vanishing card. */
const DONE_LINGER_MS = 2000;
/** Rows a trace shows before folding the older ones behind "N earlier steps". */
const RECENT_ROWS = 5;

/** Ticks `setNow` each second while `active`; the clock stands still otherwise. */
function useTick(active: boolean, setNow: (ms: number) => void) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, setNow]);
}

/**
 * Runs that are working right now, each with what its agent is doing — shown first wherever the
 * user waits for one (the automation's page, the Inbox), so nobody waits on a run they cannot see.
 * One run is open at a time (the newest, until the user picks another); the rest are one line.
 * A run that just succeeded stays for a moment with a check, then leaves.
 */
export function RunningNow({
  runs,
  automations,
  client,
  projects = [],
  showAutomation = true,
}: {
  runs: AutomationRun[];
  automations: Automation[];
  client: AutomationClient;
  projects?: AutomationProject[];
  /** Name each run's automation: off on that automation's own page. */
  showAutomation?: boolean;
}) {
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const shown = runs.filter(
    (run) => isBusy(run) || (run.status === "succeeded" && run.finishedAtMs !== null && run.finishedAtMs > now - DONE_LINGER_MS),
  );
  useTick(shown.length > 0, setNow);
  if (shown.length === 0) return null;
  const newest = shown.filter(isBusy).reduce<AutomationRun | null>((a, b) => (a && a.createdAtMs >= b.createdAtMs ? a : b), null);
  const open = picked === undefined ? newest?.id : picked;
  return (
    <section className="au-running" aria-label="Running now">
      <h2 className="au-group-title">Running now</h2>
      <ul className="au-running-list">
        {shown.map((run) => {
          const automation = automations.find((a) => a.id === run.automationId);
          const config = automation?.actionKind === "agent_prompt" ? automation.prompt : automation?.config;
          const pane = config?.openPane && config.workspaceId ? (projects.find((p) => p.id === config.workspaceId)?.name ?? "its project") : null;
          return (
            <RunCard
              key={run.id}
              run={run}
              name={showAutomation ? (automation?.name ?? run.automationName) : null}
              pane={pane}
              client={client}
              now={now}
              open={run.id === open}
              onToggle={() => setPicked(run.id === open ? null : run.id)}
            />
          );
        })}
      </ul>
    </section>
  );
}

function RunCard({
  run,
  name,
  pane,
  client,
  now,
  open,
  onToggle,
}: {
  run: AutomationRun;
  name: string | null;
  pane: string | null;
  client: AutomationClient;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const busy = isBusy(run);
  const steps = useRunSteps(client, run.id, busy && !pane);
  const done = !busy;
  const elapsed = formatElapsed((done && run.finishedAtMs !== null ? run.finishedAtMs : now) - run.createdAtMs);
  const latest = steps[steps.length - 1];
  return (
    <li className="au-running-item" data-open={open || undefined} data-done={done || undefined}>
      <button type="button" className="au-running-head" aria-expanded={open} onClick={onToggle}>
        {done ? <StatusIcon status={run.status} /> : <DitherOrb />}
        {name ? <span className="au-running-name">{name}</span> : null}
        <span className="au-running-subject">{runSubject(run)}</span>
        <span className="au-running-when" title={`Started ${formatWhen(run.createdAtMs)}`}>
          {run.status === "queued" ? "Queued" : elapsed}
        </span>
        <ChevronDown size={14} className="au-running-chevron" aria-hidden />
      </button>
      {open && busy ? <DitherStrip /> : null}
      {done ? (
        <p className="au-running-now">
          <FileCheck size={12} aria-hidden /> Finished in {elapsed}
        </p>
      ) : pane ? (
        <p className="au-hint au-running-pane">
          <SquareTerminal size={12} aria-hidden /> Running in a pane in {pane}: look there, it may be asking you to allow a tool.
        </p>
      ) : open ? (
        <RunTrace steps={steps} now={now} elapsed={elapsed} />
      ) : (
        <p className="au-running-now">
          {latest ? <StepIcon kind={stepKind(latest.text)} /> : null}
          <span className="au-running-now-text" data-starting={latest ? undefined : ""}>
            {latest ? latest.text : "Starting the agent…"}
          </span>
          {steps.length ? <span className="au-running-count">{plural(steps.length, "step")}</span> : null}
        </p>
      )}
    </li>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const KIND_ICON: Record<StepKind, LucideIcon> = {
  github: GitPullRequest,
  notion: BookOpen,
  file: FileText,
  search: Search,
  web: Globe,
  skill: Sparkles,
  tool: Wrench,
  result: FileCheck,
  refused: ShieldAlert,
  command: SquareTerminal,
};

function StepIcon({ kind }: { kind: StepKind }) {
  const Icon = KIND_ICON[kind];
  return <Icon size={12} className="au-step-icon" data-kind={kind} aria-hidden />;
}

/**
 * The latest steps of a running headless run on a rail, newest last and the only bright one; a step
 * repeated back to back is one row with ×n. Before the first, it says it is starting.
 */
export function RunTrace({ steps, now, elapsed }: { steps: RunStep[]; now: number; elapsed: string }) {
  const [all, setAll] = useState(false);
  const rows = traceRows(steps);
  const shown = all ? rows : rows.slice(-RECENT_ROWS);
  const hidden = rows.slice(0, rows.length - shown.length).reduce((n, row) => n + row.times, 0);
  return (
    <div className="au-trace">
      <p className="au-trace-head">
        <Brain size={12} aria-hidden /> Working for {elapsed}
        {steps.length ? ` · ${plural(steps.length, "step")}` : ""}
      </p>
      {hidden > 0 ? (
        <button type="button" className="au-trace-more" onClick={() => setAll(true)}>
          {plural(hidden, "earlier step")}
        </button>
      ) : null}
      <ol className="au-steps" aria-label="What the agent is doing" aria-live="polite">
        {shown.length === 0 ? (
          <li className="au-step" data-current>
            <span className="au-step-text" data-starting="">
              Starting the agent…
            </span>
          </li>
        ) : (
          shown.map((row, i) => {
            const current = i === shown.length - 1;
            const took = rowTime(row, now);
            return (
              <li key={row.atMs} className="au-step" data-current={current || undefined} data-kind={row.kind}>
                <StepIcon kind={row.kind} />
                <span className="au-step-text">{row.text}</span>
                {row.times > 1 ? <span className="au-step-times">×{row.times}</span> : null}
                {took ? <span className="au-step-took">{current ? `${took}…` : took}</span> : null}
              </li>
            );
          })
        )}
      </ol>
    </div>
  );
}

/**
 * Running as one live line on top of Inbox (the Dock's quiet list, `.pen` 16 v2): not a destination
 * of its own, it leaves when the run ends. Pressed, it opens the full list with each agent's steps.
 */
export function RunningLine({
  runs,
  automations,
  client,
  projects = [],
}: {
  runs: AutomationRun[];
  automations: Automation[];
  client: AutomationClient;
  projects?: AutomationProject[];
}) {
  const [expanded, setExpanded] = useState(false);
  const busy = runs.filter(isBusy);
  if (busy.length === 0) return null;
  const first = busy[0];
  const name = automations.find((a) => a.id === first.automationId)?.name ?? first.automationName;
  return (
    <div className="au-live">
      <button type="button" className="au-live-line" aria-expanded={expanded} onClick={() => setExpanded((was) => !was)}>
        <DitherOrb pixel={1.5} />
        <span className="au-live-name">{name}</span>
        <span className="au-live-subject">{runSubject(first)}</span>
        {busy.length > 1 ? <span className="au-live-more">+{busy.length - 1} more</span> : null}
        <span className="au-live-when">{formatWhen(first.createdAtMs)}</span>
      </button>
      {expanded ? <RunningNow runs={runs} automations={automations} client={client} projects={projects} /> : null}
    </div>
  );
}
