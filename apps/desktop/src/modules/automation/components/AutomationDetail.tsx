"use client";

import { ChevronDown, CircleAlert, Folder, Hash, Inbox, Lock, MessagesSquare, Pause, Pencil, Play, Settings2, SquareTerminal, Trash2, UserRound, Wrench } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  DetailHeader,
  DetailSection,
  EmptyState,
  IconButton,
  MenuItem,
  MenuSeparator,
  OverflowMenu,
  ResourceMeta,
  StatusIcon,
  Switch,
} from "@/components/resource/resource-kit";
import { SlackMark } from "@/components/icons/ServiceMarks";

import { useSlackChannelNames } from "../hooks/useSlackChannelNames";
import { GitHubSource } from "./GitHubSource";
import { ReplyStyleHint, SlackReplyPreview } from "./ReplyStyleHint";
import type {
  AgentPreset,
  Automation,
  AutomationClient,
  AutomationDraft,
  AutomationProject,
  AutomationRun,
  SlackChannel,
  SlackStatus,
} from "../services/automation-api";
import { lastRunOf, triggerOf } from "../services/automation-list";
import { describeCron, formatDuration, formatWhen } from "../services/format";
import { AskCard, isAsk } from "./AskCard";
import { DraftCard } from "./DraftCard";
import { ShowMore, waitsForYou, wasDelivered } from "./InboxTab";
import { metaOf, TriggerIcon } from "./InstalledTab";
import { ResultCard } from "./ResultCard";
import { isBusy, RunningNow, runSubject } from "./RunningNow";
import { RunThread } from "./RunThread";
import { AgentField } from "./AgentField";
import { SlackTriggerEditor } from "./SlackTriggerEditor";

/** Delivered results shown before "Show all": the latest few say what it has been saying. */
const RECENT_STEP = 3;

/**
 * One automation: what it does, when it runs, where results go, and what it did. The layout is
 * bb's detail page — header with the switch and "…", then sections split by hairlines — with the
 * parts Lotus adds: the review box for PR reviews and this automation's own Inbox.
 */
export function AutomationDetail({
  automation: a,
  runs,
  drafts,
  results,
  presets,
  slack,
  client,
  onEdit,
  onDeleted,
  onOpenConnectors,
  projects = [],
  variant = "page",
}: {
  automation: Automation;
  runs: AutomationRun[];
  drafts: AutomationDraft[];
  results: AutomationDraft[];
  presets: AgentPreset[];
  slack: SlackStatus | null;
  client: AutomationClient;
  onEdit: () => void;
  onDeleted: () => void;
  onOpenConnectors: () => void;
  /** The window's workspaces, to name the project this automation runs in. */
  projects?: AutomationProject[];
  /**
   * `pane` is the Settings pane beside a channel: the channel already shows what is running, what
   * waits, and the review box, so the pane keeps only how it is set up and its runs.
   */
  variant?: "page" | "pane";
}) {
  const inPane = variant === "pane";
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const isPrompt = a.actionKind === "agent_prompt";
  const own = runs.filter((r) => r.automationId === a.id);
  const last = lastRunOf(a, runs);
  const pausedByFailures = !a.enabled && (last?.status === "failed" || last?.status === "interrupted");
  const waiting = [...drafts, ...results.filter((r) => !drafts.some((d) => d.id === r.id))]
    .filter((d) => d.automationId === a.id && waitsForYou(d))
    // An Ask blocks this automation's agent: it comes first, as in the Inbox.
    .sort((x, y) => Number(isAsk(y)) - Number(isAsk(x)));
  const channels = useSlackChannelNames(client, waiting.some((d) => d.slack));
  const delivered = results.filter((r) => r.automationId === a.id && wasDelivered(r));
  const [deliveredShown, setDeliveredShown] = useState(RECENT_STEP);

  const act = (work: Promise<unknown>, done?: string) => {
    setNotice(null);
    work.then(() => done && setNotice({ tone: "info", text: done })).catch((e: unknown) => setNotice({ tone: "error", text: String(e) }));
  };

  const runNow = () => act(client.runScheduledNow(a.id), "Run started. It shows under Runs, and the result in Inbox.");
  const toggle = (on: boolean) => act(client.setEnabled(a.id, on));
  const remove = () => {
    setNotice(null);
    client
      .deleteAutomation(a.id)
      .then(onDeleted)
      .catch((e: unknown) => setNotice({ tone: "error", text: String(e) }));
  };
  const focusReview = () => document.getElementById("au-review-url")?.focus();

  const confirmBox = (
        <div className="au-callout au-callout--danger" role="alertdialog" aria-label="Delete automation">
          <p>
            Delete “{a.name}”? Its runs, drafts and results are removed too. This cannot be undone.
          </p>
          <span className="au-draft-actions">
            <button type="button" className="rs-button rs-button--ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button type="button" className="rs-button rs-button--danger" onClick={remove}>
              Delete
            </button>
          </span>
        </div>
  );

  return (
    <>
      <DetailHeader
        icon={<TriggerIcon kind={triggerOf(a).kind} />}
        // In the pane, its bar already says "Settings"; the body names what is being set.
        title={a.name}
        level={inPane ? 3 : 1}
        meta={<ResourceMeta items={metaOf(a, 12)} />}
        actions={
          <>
            <Switch checked={a.enabled} onChange={toggle} label={a.enabled ? "Turn off" : "Turn on"} />
            <OverflowMenu label="More actions">
              {isPrompt ? (
                <MenuItem icon={<Play size={14} />} onSelect={runNow}>
                  Run now
                </MenuItem>
              ) : (
                <MenuItem icon={<Play size={14} />} onSelect={focusReview}>
                  Review a pull request
                </MenuItem>
              )}
              <MenuItem icon={<Settings2 size={14} />} onSelect={onEdit}>
                Edit settings
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 size={14} />} tone="danger" onSelect={() => setConfirmDelete(true)}>
                Delete
              </MenuItem>
            </OverflowMenu>
          </>
        }
      />

      {confirmDelete && !inPane ? confirmBox : null}

      {!a.enabled && !confirmDelete ? (
        pausedByFailures ? (
          <div className="au-callout au-callout--danger">
            <CircleAlert size={15} aria-hidden />
            <p>
              {last?.advice
                ? `Paused after failing three times in a row. ${last.advice}`
                : `Paused after failing three times in a row. Last error: ${last?.detail ?? "unknown"}. Fix the cause, then turn it on.`}
            </p>
            <button type="button" className="rs-button" onClick={() => toggle(true)}>
              Turn on
            </button>
          </div>
        ) : (
          <div className="au-callout">
            <p>Off. It runs only after you turn it on. Check the prompt, schedule and delivery below first.</p>
            <button type="button" className="rs-button rs-button--primary" onClick={() => toggle(true)}>
              Turn on
            </button>
          </div>
        )
      ) : null}

      {notice ? (
        <p className={notice.tone === "error" ? "au-error au-notice" : "au-note au-notice"} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      ) : null}

      <PromptSection automation={a} presets={presets} client={client} projects={projects} />
      <TriggerSection automation={a} slack={slack} client={client} onOpenConnectors={onOpenConnectors} />
      {isPrompt ? <DeliverySection automation={a} /> : inPane ? null : <ReviewNowSection automation={a} client={client} runs={runs} />}

      {inPane ? null : <RunningNow runs={own} automations={[a]} client={client} projects={projects} showAutomation={false} />}

      {!inPane && waiting.length > 0 ? (
        <DetailSection title="Waiting for you" id="au-own-inbox">
          <div className="au-stack">
            {waiting.map((d) =>
              isAsk(d) ? (
                <AskCard key={d.id} ask={d} client={client} />
              ) : d.kind === "pr_review" ? (
                <DraftCard
                  key={d.id}
                  draft={d}
                  client={client}
                  account={a.config?.account}
                  channelName={d.slack ? channels.get(d.slack.channel) : undefined}
                />
              ) : (
                <ResultCard key={d.id} result={d} client={client} />
              ),
            )}
          </div>
        </DetailSection>
      ) : null}

      {!inPane && delivered.length > 0 ? (
        <DetailSection title="Recent results" id="au-own-results">
          <div className="au-stack">
            {delivered.slice(0, deliveredShown).map((r) => (
              <ResultCard key={r.id} result={r} client={client} />
            ))}
          </div>
          <ShowMore shown={deliveredShown} total={delivered.length} onMore={() => setDeliveredShown(delivered.length)} />
        </DetailSection>
      ) : null}

      <DetailSection title="Runs" id="au-runs">
        {own.length === 0 ? (
          <EmptyState
            action={
              isPrompt ? (
                <button type="button" className="rs-button" onClick={runNow}>
                  <Play size={13} aria-hidden />
                  Run now
                </button>
              ) : undefined
            }
          >
            {isPrompt ? "No runs yet." : "No runs yet. Review a pull request above, or let Slack start one."}
          </EmptyState>
        ) : (
          <ul className="au-runs" aria-label="Runs">
            {own.slice(0, 50).map((run) => (
              <RunRow key={run.id} run={run} client={client} kind={a.actionKind} />
            ))}
          </ul>
        )}
      </DetailSection>

      {inPane ? (
        <footer className="au-pane-foot" aria-label="Automation controls">
          <p className="au-pane-rules">
            <Lock size={12} aria-hidden />
            {isPrompt
              ? "Results wait in Inbox. Nothing posts to a channel until you press Send."
              : "Drafts wait in Inbox. Nothing posts until you press Send. Reviews post as Comment; Approve is a separate step."}
          </p>
          {confirmDelete ? (
            confirmBox
          ) : (
            <span className="au-draft-actions">
              {/* When off, the callout at the top already offers Turn on. */}
              {a.enabled ? (
                <button type="button" className="rs-button" onClick={() => toggle(false)}>
                  <Pause size={13} aria-hidden />
                  Pause
                </button>
              ) : null}
              <button type="button" className="rs-button rs-button--danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={13} aria-hidden />
                Delete…
              </button>
            </span>
          )}
        </footer>
      ) : null}
    </>
  );
}

/**
 * One run. It expands in place: a run that kept its agent conversation shows it as a thread, to
 * read and to write to; any other shows its whole outcome, which the row truncates.
 */
export function RunRow({ run, client, kind }: { run: AutomationRun; client: AutomationClient; kind?: string }) {
  const [expanded, setExpanded] = useState(false);
  const took = run.finishedAtMs ? formatDuration(run.finishedAtMs - run.createdAtMs) : null;
  const subject = runSubject(run);
  const busy = isBusy(run);
  const outcome = busy ? "Running…" : [took, run.advice ?? run.detail].filter(Boolean).join(" · ");
  const talks = Boolean(run.sessionCwd);
  return (
    <li className="au-run" data-status={run.status} data-expanded={expanded || undefined}>
      <button
        type="button"
        className="au-run-button"
        aria-label={`${subject}, ${formatWhen(run.createdAtMs)}`}
        aria-expanded={expanded}
        title={talks ? "Show the conversation with the agent" : "Show the whole outcome"}
        onClick={() => setExpanded((v) => !v)}
      >
        <StatusIcon status={run.status} />
        <span className="au-run-when">{formatWhen(run.createdAtMs)}</span>
        <span className="au-run-subject" title={run.key}>
          {subject}
        </span>
        <span className="au-run-detail">{outcome}</span>
        <span className="au-run-go" aria-hidden>
          {talks ? <MessagesSquare size={13} /> : <ChevronDown size={13} />}
        </span>
      </button>
      {expanded ? (
        <div className="au-run-more">
          {talks ? (
            <>
              {run.advice ? <p className="au-run-more-text">{run.advice}</p> : null}
              {run.detail ? <p className={run.advice ? "au-hint" : "au-run-more-text"}>{run.detail}</p> : null}
              <RunThread client={client} runId={run.id} kind={kind} />
            </>
          ) : (
            <>
              {run.advice ? <p className="au-run-more-text">{run.advice}</p> : null}
              <p className={run.advice ? "au-hint" : "au-run-more-text"}>{run.detail ?? (busy ? "Still running." : "No details were recorded.")}</p>
              <p className="au-hint">
                {run.key} · no saved conversation{run.status === "skipped" ? ": it was skipped before the agent started" : ""}
              </p>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function Chip({ icon, children, title }: { icon: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className="au-chip" title={title}>
      <span className="au-chip-icon" aria-hidden>
        {icon}
      </span>
      {children}
    </span>
  );
}

/**
 * Common review focuses, one press each. Each appends a plain line to the instructions being
 * edited; nothing saves until Save. A focus already in the text is not offered again.
 */
export const REVIEW_FOCUSES: { label: string; line: string }[] = [
  { label: "Security", line: "Check for security problems: injection, auth and permission gaps, secrets in code, unsafe input handling." },
  { label: "Performance", line: "Flag performance problems: needless work in loops, N+1 queries, large allocations, blocking calls on hot paths." },
  {
    label: "Breaking API changes",
    line: "Call out breaking API changes: removed or renamed exports, changed signatures or response shapes, and missing migration notes.",
  },
];

function FocusChips({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const left = REVIEW_FOCUSES.filter((f) => !value.includes(f.line));
  if (left.length === 0) return null;
  return (
    <span className="au-focus-chips" role="group" aria-label="Add a review focus">
      {left.map((f) => (
        <button
          key={f.label}
          type="button"
          className="au-focus-chip"
          onClick={() => onChange(value.trim() ? `${value.trimEnd()}\n${f.line}` : f.line)}
        >
          + {f.label}
        </button>
      ))}
    </span>
  );
}

function PromptSection({
  automation: a,
  presets,
  client,
  projects,
}: {
  automation: Automation;
  presets: AgentPreset[];
  client: AutomationClient;
  projects: AutomationProject[];
}) {
  const isPrompt = a.actionKind === "agent_prompt";
  const text = isPrompt ? (a.prompt?.prompt ?? "") : (a.config?.instructions ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [editing, text]);

  const presetId = a.prompt?.presetId ?? a.config?.presetId ?? "";
  const workspaceId = (isPrompt ? a.prompt?.workspaceId : a.config?.workspaceId) ?? null;
  const openPane = (isPrompt ? a.prompt?.openPane : a.config?.openPane) ?? false;
  const projectName = projects.find((p) => p.id === workspaceId)?.name ?? "A project that is not open";
  const tools = (isPrompt ? a.prompt?.tools : a.config?.mcpTools) ?? [];

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await client.updatePrompt(a.id, draft);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <div className="au-prompt-foot">
      {workspaceId && openPane ? (
        <Chip icon={<SquareTerminal size={13} />} title="Each run opens a pane in this project and works there">
          {projectName}
        </Chip>
      ) : workspaceId ? (
        <Chip icon={<Folder size={13} />} title="Each run works in this project's folder, in the background; follow it under Runs">
          {projectName}
        </Chip>
      ) : (
        <Chip icon={<Folder size={13} />} title="Runs in the background, like any agent you start: every tool, your skills and settings">
          {(isPrompt ? a.prompt?.workdir : a.config?.workdir) ?? "Background"}
        </Chip>
      )}
      <Chip
        icon={<Wrench size={13} />}
        title={
          tools.length > 0
            ? tools.join(", ")
            : isPrompt
              ? "No extra tools beyond the agent's own"
              : "Read-only review: it reads the code and the PR, and every other tool stays off"
        }
      >
        {tools.length === 0 ? (isPrompt ? "Default tools" : "Read-only") : `${tools.length} tool${tools.length === 1 ? "" : "s"}`}
      </Chip>
      {(a.prompt?.includeReviewRequests || !isPrompt) && (a.prompt?.account ?? a.config?.account) ? (
        <Chip icon={<UserRound size={13} />} title="GitHub account">
          {isPrompt ? `Review queue of ${a.prompt?.account}` : `Posts as ${a.config?.account}`}
        </Chip>
      ) : null}
    </div>
  );

  return (
    <DetailSection
      title={isPrompt ? "Prompt" : "Review instructions"}
      id="au-prompt"
      actions={
        editing ? null : (
          <IconButton label={isPrompt ? "Edit prompt" : "Edit instructions"} onClick={() => setEditing(true)}>
            <Pencil size={14} aria-hidden />
          </IconButton>
        )
      }
    >
      {editing ? (
        <form className="au-prompt au-prompt--editing" onSubmit={(e) => void save(e)}>
          <textarea
            className="au-prompt-input"
            aria-label={isPrompt ? "Prompt" : "Instructions"}
            value={draft}
            rows={6}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(e);
            }}
          />
          {error ? (
            <p className="au-error au-prompt-error" role="alert">
              {error}
            </p>
          ) : null}
          {isPrompt ? null : <FocusChips value={draft} onChange={setDraft} />}
          {isPrompt ? null : <ReplyStyleHint value={draft} onChange={setDraft} />}
          {isPrompt ? null : <SlackReplyPreview instructions={draft} />}
          <div className="au-prompt-actions">
            <span className="au-hint">⌘↵ to save · Esc to cancel</span>
            <span className="au-draft-actions">
              <button type="button" className="rs-button rs-button--ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="submit" className="rs-button rs-button--primary" disabled={saving || (isPrompt && !draft.trim())}>
                {saving ? "Saving…" : "Save"}
              </button>
            </span>
          </div>
        </form>
      ) : (
        <div className="au-prompt">
          <p className="au-prompt-text" data-empty={text ? undefined : "true"}>
            {text || "No extra instructions. The repository's REVIEW.md or CLAUDE.md still applies."}
          </p>
          <div className="au-prompt-agent">
            <span className="au-prompt-agent-label">Agent</span>
            <AgentField
              presets={presets}
              value={presetId}
              onChange={async (ref) => {
                setError(null);
                await client.updateAgent(a.id, ref).catch((e: unknown) => setError(String(e)));
              }}
            />
          </div>
          {error ? (
            <p className="au-error au-prompt-error" role="alert">
              {error}
            </p>
          ) : null}
          {footer}
        </div>
      )}
    </DetailSection>
  );
}

function TriggerSection({
  automation: a,
  slack,
  client,
  onOpenConnectors,
}: {
  automation: Automation;
  slack: SlackStatus | null;
  client: AutomationClient;
  onOpenConnectors: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [channelNames, setChannelNames] = useState<Map<string, SlackChannel>>(new Map());
  const slackUp =
    slack?.state === "connected" || slack?.state === "standby" || slack?.state === "retrying" || slack?.state === "connecting";
  const listensInSlack = a.triggerKind === "slack" && a.slack;

  useEffect(() => {
    if (!listensInSlack || !slackUp) return;
    let alive = true;
    void client
      .slackChannels()
      .then((list) => alive && setChannelNames(new Map(list.map((c) => [c.id, c]))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, listensInSlack, slackUp]);

  if (a.schedule) {
    return (
      <DetailSection title="Schedule" id="au-trigger">
        <div className="au-facts">
          <div className="au-fact">
            <span className="au-fact-label">Runs</span>
            <span className="au-fact-value">{describeCron(a.schedule.cron)}</span>
          </div>
          <div className="au-fact">
            <span className="au-fact-label">Time zone</span>
            <span className="au-fact-value">{a.schedule.timezone}</span>
          </div>
          <div className="au-fact">
            <span className="au-fact-label">Next run</span>
            <span className="au-fact-value">{a.nextRunMs ? formatWhen(a.nextRunMs) : a.enabled ? "Not scheduled" : "Off"}</span>
          </div>
          <div className="au-fact">
            <span className="au-fact-label">Pattern</span>
            <code className="au-fact-value au-fact-code">{a.schedule.cron}</code>
          </div>
        </div>
        <p className="au-hint">Missed while Lotus was closed: runs once when Lotus opens again, never more.</p>
      </DetailSection>
    );
  }

  return (
    <DetailSection
      title="Starts from"
      id="au-trigger"
      actions={
        slackUp && !editing ? (
          <button type="button" className="rs-button rs-button--ghost" onClick={() => setEditing(true)}>
            <SlackMark size={12} />
            {listensInSlack ? "Change channel" : "Listen in Slack"}
          </button>
        ) : null
      }
    >
      {editing ? (
        <SlackTriggerEditor automation={a} client={client} onDone={() => setEditing(false)} />
      ) : listensInSlack ? (
        <div className="au-facts">
          <div className="au-fact">
            <span className="au-fact-label">Channels</span>
            <span className="au-fact-value">
              {a.slack!.channels.map((id) => {
                const c = channelNames.get(id);
                return (
                  <span key={id} className="au-chip">
                    <Hash size={12} aria-hidden />
                    {c?.name ?? id}
                  </span>
                );
              })}
            </span>
          </div>
          <div className="au-fact">
            <span className="au-fact-label">Counts as you</span>
            <span className="au-fact-value">{a.slack!.team ? "Your mentions and your team's" : "Mentions of you"}</span>
          </div>
          <div className="au-fact au-fact--wide">
            <span className="au-fact-label">Also</span>
            <span className="au-fact-value">Your :eyes: reaction on a message with a PR link</span>
          </div>
          {!slackUp ? (
            <p className="au-callout au-callout--warn au-fact--wide">
              Slack is not connected, so nothing starts from there right now.{" "}
              <button type="button" className="au-link" onClick={onOpenConnectors}>
                Open Connectors
              </button>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="au-note">
          On demand: paste a PR link below.{" "}
          {slackUp ? null : (
            <>
              To start reviews from Slack mentions,{" "}
              <button type="button" className="au-link" onClick={onOpenConnectors}>
                connect Slack
              </button>
              .
            </>
          )}
        </p>
      )}
      {a.actionKind === "pr_review" && !editing ? <GitHubSource automation={a} client={client} /> : null}
    </DetailSection>
  );
}

function DeliverySection({ automation: a }: { automation: Automation }) {
  const p = a.prompt;
  return (
    <DetailSection title="Delivered to" id="au-delivery">
      <div className="au-prompt-foot au-prompt-foot--flat">
        <Chip icon={<Inbox size={13} />}>Inbox, with a notification</Chip>
        {p?.dmSelf ? <Chip icon={<SlackMark size={11} />}>Your Slack DM, automatically</Chip> : null}
        {p?.slackChannel ? (
          <Chip icon={<Hash size={13} />} title="Channel posts wait for Send">
            Channel post, after you press Send
          </Chip>
        ) : null}
      </div>
    </DetailSection>
  );
}

function outcomeOf(run: AutomationRun): { tone: "info" | "error"; text: string } | null {
  const why = run.advice ?? run.detail;
  const reason = why ? `: ${why}` : "";
  switch (run.status) {
    case "succeeded":
      return { tone: "info", text: "Draft ready. It is waiting for you above and in Inbox." };
    case "skipped":
      return { tone: "info", text: `Skipped${reason}` };
    case "asked":
      return { tone: "info", text: "The agent asked you a question. It is waiting in Inbox." };
    case "failed":
    case "interrupted":
      return { tone: "error", text: `Failed${reason}` };
    default:
      return null;
  }
}

export function ReviewNowSection({ automation: a, client, runs }: { automation: Automation; client: AutomationClient; runs: AutomationRun[] }) {
  const [url, setUrl] = useState("");
  const [started, setStarted] = useState<{ runId: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = started ? runs.find((r) => r.id === started.runId) : undefined;
  const message = error
    ? { tone: "error" as const, text: error }
    : started
      ? ((run && outcomeOf(run)) ?? { tone: "info" as const, text: started.text })
      : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setStarted(null);
    try {
      const result = await client.runNow(a.id, url.trim());
      setStarted({
        runId: result.runId,
        text: result.status === "started" ? "Reviewing. Its steps show under Running now, and the draft appears in Inbox when it is ready." : "This commit is already being reviewed, or has a draft. Its run is below.",
      });
      if (result.status === "started") setUrl("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <DetailSection title="Review a pull request" id="au-review">
      <form className="au-review" onSubmit={(e) => void submit(e)}>
        <input
          id="au-review-url"
          className="au-input"
          aria-label="Pull request URL"
          placeholder="https://github.com/owner/repo/pull/123"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="rs-button rs-button--primary" disabled={!url.trim()}>
          Review
        </button>
      </form>
      {message ? (
        <p className={message.tone === "error" ? "au-error" : "au-note"} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : (
        <p className="au-hint">The reviewer works like any agent you start, in this automation’s project. Nothing reaches GitHub until you press Send.</p>
      )}
    </DetailSection>
  );
}
