"use client";

import { ChevronLeft, ChevronRight, Play, Settings2, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { EmptyState, MenuItem, MenuSeparator, OverflowMenu, Switch } from "@/components/resource/resource-kit";

import { useSlackChannelNames } from "../hooks/useSlackChannelNames";
import type { AgentPreset, Automation, AutomationClient, AutomationDraft, AutomationProject, AutomationRun } from "../services/automation-api";
import { lastRunOf, rowNext } from "../services/automation-list";
import { parseAgentRef } from "../services/agent-ref";
import { describeCron, formatWhen } from "../services/format";
import { previewLine, rowStatus } from "../services/inbox-model";
import { AskCard, isAsk } from "./AskCard";
import { ReviewNowSection, RunRow } from "./AutomationDetail";
import { DraftCard } from "./DraftCard";
import { waitsForYou } from "./InboxTab";
import { ResultCard } from "./ResultCard";

/**
 * One automation in the Dock (`.pen` 16d v2). It replaces the list it was opened from: its title and
 * switch, when it runs next, then what waits for you from it, and its setup as label · value facts,
 * each with Edit on hover. Runs are one line each. A PR reviewer keeps its review box at the foot.
 */
export function DockAutomation({
  automation: a,
  runs,
  drafts,
  results,
  presets,
  client,
  projects = [],
  onBack,
  onEdit,
  onDeleted,
}: {
  automation: Automation;
  runs: AutomationRun[];
  drafts: AutomationDraft[];
  results: AutomationDraft[];
  presets: AgentPreset[];
  client: AutomationClient;
  projects?: AutomationProject[];
  onBack: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const isPrompt = a.actionKind === "agent_prompt";
  const own = runs.filter((r) => r.automationId === a.id);
  const last = lastRunOf(a, runs);
  const waiting = [...drafts, ...results.filter((r) => !drafts.some((d) => d.id === r.id))]
    .filter((d) => d.automationId === a.id && waitsForYou(d))
    .sort((x, y) => Number(isAsk(y)) - Number(isAsk(x)));
  const channels = useSlackChannelNames(
    client,
    a.triggerKind === "slack" || Boolean(a.prompt?.slackChannel) || waiting.some((d) => d.slack || d.result?.channel),
  );
  const channelName = (id: string) => channels.get(id) ?? id;

  const act = (work: Promise<unknown>, done?: string) => {
    setNotice(null);
    work.then(() => done && setNotice({ tone: "info", text: done })).catch((e: unknown) => setNotice({ tone: "error", text: String(e) }));
  };
  const runNow = () => act(client.runScheduledNow(a.id), "Run started. It shows under Runs, and the result waits here.");
  const toggle = (on: boolean) => act(client.setEnabled(a.id, on));
  const remove = () => {
    setNotice(null);
    client
      .deleteAutomation(a.id)
      .then(onDeleted)
      .catch((e: unknown) => setNotice({ tone: "error", text: String(e) }));
  };

  const next = rowNext(a, { lastRun: last, channelName: (id) => channels.get(id) });
  const state =
    next.tone === "error"
      ? next
      : !a.enabled
        ? { tone: "plain" as const, text: "Off · runs only after you turn it on" }
        : a.schedule && a.nextRunMs
          ? { tone: "plain" as const, text: `Next run ${formatWhen(a.nextRunMs)}` }
          : next;

  return (
    <>
      <header className="au-dhead au-dhead--back">
        <button type="button" className="au-dock-backlink" aria-label="Back to automations" onClick={onBack}>
          <ChevronLeft size={15} strokeWidth={1.75} aria-hidden />
          Automations
        </button>
        <OverflowMenu label="More actions">
          {isPrompt ? (
            <MenuItem icon={<Play size={14} />} onSelect={runNow}>
              Run now
            </MenuItem>
          ) : null}
          <MenuItem icon={<Settings2 size={14} />} onSelect={onEdit}>
            Edit settings
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={14} />} tone="danger" onSelect={() => setConfirmDelete(true)}>
            Delete
          </MenuItem>
        </OverflowMenu>
      </header>

      <div className="au-main-scroll">
        <div className="au-main-inner au-dauto">
          <div className="au-dauto-head">
            <div className="au-dauto-titleline">
              <h1 className="au-dauto-title">{a.name}</h1>
              <Switch checked={a.enabled} onChange={toggle} label={a.enabled ? "Turn off" : "Turn on"} />
            </div>
            <div className="au-dauto-state">
              <span className="au-dauto-next" data-tone={state.tone}>
                {state.text}
              </span>
              {isPrompt ? (
                <button type="button" className="rs-button au-dauto-run" onClick={runNow}>
                  <Play size={12} aria-hidden />
                  Run now
                </button>
              ) : null}
            </div>
          </div>

          {confirmDelete ? (
            <div className="au-callout au-callout--danger" role="alertdialog" aria-label="Delete automation">
              <p>Delete “{a.name}”? Its runs, drafts and results are removed too. This cannot be undone.</p>
              <span className="au-draft-actions">
                <button type="button" className="rs-button rs-button--ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button type="button" className="rs-button rs-button--danger" onClick={remove}>
                  Delete
                </button>
              </span>
            </div>
          ) : null}

          {notice ? (
            <p className={notice.tone === "error" ? "au-error au-notice" : "au-note au-notice"} role={notice.tone === "error" ? "alert" : "status"}>
              {notice.text}
            </p>
          ) : null}

          {waiting.length > 0 ? (
            <Section title={`Waiting for you · ${waiting.length}`}>
              <ul className="au-dwait" aria-label="Waiting for you">
                {waiting.map((d) => {
                  const status = rowStatus(d, { channelName });
                  const open = openId === d.id;
                  const title = isAsk(d) ? previewLine(d.ask?.question ?? "", 120) || d.subject : d.subject;
                  return (
                    <li key={d.id} className="au-dwait-item" data-tone={status.tone} data-open={open || undefined}>
                      <button type="button" className="au-dwait-row" aria-expanded={open} onClick={() => setOpenId(open ? null : d.id)}>
                        <span className="au-qrow-dot" aria-hidden />
                        <span className="au-dwait-text">
                          <span className="au-dwait-title">{title}</span>
                          <span className="au-dwait-status">
                            {status.text} · {formatWhen(d.createdAtMs)}
                          </span>
                        </span>
                        <ChevronRight size={13} className="au-dwait-go" aria-hidden />
                      </button>
                      {open ? (
                        <div className="au-dwait-card">
                          {isAsk(d) ? (
                            <AskCard ask={d} client={client} />
                          ) : d.kind === "pr_review" ? (
                            <DraftCard
                              draft={d}
                              client={client}
                              account={a.config?.account}
                              channelName={d.slack ? channels.get(d.slack.channel) : undefined}
                              quiet
                            />
                          ) : (
                            <ResultCard result={d} client={client} />
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Section>
          ) : null}

          <Section title={isPrompt ? "What the agent does" : "Review instructions"}>
            <div className="au-dprompt">
              <p className="au-dprompt-text" data-empty={promptOf(a) ? undefined : "true"}>
                {promptOf(a) || "No extra instructions. The repository's REVIEW.md or CLAUDE.md still applies."}
              </p>
              <EditButton label={isPrompt ? "prompt" : "instructions"} onEdit={onEdit} />
            </div>
          </Section>

          <Section title="When">
            {whenFacts(a, channelName).map(([key, value]) => (
              <Fact key={key} label={key} onEdit={onEdit}>
                {value}
              </Fact>
            ))}
          </Section>

          <Section title="Delivered to">
            {deliveryFacts(a, channelName).map(([key, value]) => (
              <Fact key={key} label={key} onEdit={onEdit}>
                {value}
              </Fact>
            ))}
          </Section>

          <Section title="Runs as">
            {runsAsFacts(a, presets, projects).map(([key, value]) => (
              <Fact key={key} label={key} onEdit={onEdit}>
                {value}
              </Fact>
            ))}
          </Section>

          <Section title="Runs">
            {own.length === 0 ? (
              <EmptyState>{isPrompt ? "No runs yet." : "No runs yet. Review a pull request below, or let Slack start one."}</EmptyState>
            ) : (
              <ul className="au-runs" aria-label="Runs">
                {own.slice(0, 50).map((run) => (
                  <RunRow key={run.id} run={run} client={client} kind={a.actionKind} />
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>

      {isPrompt ? null : (
        <div className="au-composer">
          <ReviewNowSection automation={a} client={client} runs={runs} />
        </div>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="au-dsec" aria-label={title}>
      <h2 className="au-dsec-title">{title}</h2>
      {children}
    </section>
  );
}

function EditButton({ label, onEdit }: { label: string; onEdit: () => void }) {
  return (
    <button type="button" className="au-dfact-edit" aria-label={`Edit ${label}`} onClick={onEdit}>
      Edit
    </button>
  );
}

function Fact({ label, children, onEdit }: { label: string; children: ReactNode; onEdit: () => void }) {
  return (
    <div className="au-dfact">
      <span className="au-dfact-key">{label}</span>
      <span className="au-dfact-value">{children}</span>
      <EditButton label={label.toLowerCase()} onEdit={onEdit} />
    </div>
  );
}

function promptOf(a: Automation): string {
  return (a.actionKind === "agent_prompt" ? a.prompt?.prompt : a.config?.instructions) ?? "";
}

type Facts = [string, string][];

/** When it starts, as facts. Exported for tests. */
export function whenFacts(a: Automation, channelName: (id: string) => string): Facts {
  if (a.triggerKind === "schedule" && a.schedule) {
    return [
      ["Runs", describeCron(a.schedule.cron)],
      ["Time zone", a.schedule.timezone],
      ["If missed", "Once, when Lotus opens"],
    ];
  }
  const facts: Facts = [];
  if (a.triggerKind === "slack" && a.slack?.channels.length) {
    facts.push(["Listens in", a.slack.channels.map((id) => `#${channelName(id).replace(/^#/, "")}`).join(", ")]);
    facts.push(["Counts", a.slack.team ? "Your mentions and your team's" : "Mentions of you"]);
  }
  if (a.github) facts.push(["GitHub", "Review requests to you"]);
  if (facts.length === 0) facts.push(["Starts", a.actionKind === "pr_review" ? "When you paste a PR link below" : "Only when you press Run now"]);
  return facts;
}

/** Where its output goes, in order. Exported for tests. */
export function deliveryFacts(a: Automation, channelName: (id: string) => string): Facts {
  if (a.actionKind === "pr_review") {
    const account = a.config?.account;
    const facts: Facts = [
      ["First", "Inbox, waits for Send"],
      ["Then", `GitHub comment${account ? ` as ${account}` : ""}`],
    ];
    if (a.triggerKind === "slack") facts.push(["And", "A reply in the Slack thread it came from"]);
    return facts;
  }
  const p = a.prompt;
  const facts: Facts = [["First", "Inbox, with a notification"]];
  if (p?.dmSelf) facts.push(["Also", "Your Slack DM, automatically"]);
  if (p?.slackChannel) facts.push(["Then", `Posts to #${channelName(p.slackChannel).replace(/^#/, "")} as you, after Send`]);
  return facts;
}

function runsAsFacts(a: Automation, presets: AgentPreset[], projects: AutomationProject[]): Facts {
  const isPrompt = a.actionKind === "agent_prompt";
  const presetId = a.prompt?.presetId ?? a.config?.presetId ?? "";
  const preset = presets.find((p) => p.id === parseAgentRef(presetId).presetId);
  const workspaceId = (isPrompt ? a.prompt?.workspaceId : a.config?.workspaceId) ?? null;
  const openPane = (isPrompt ? a.prompt?.openPane : a.config?.openPane) ?? false;
  const tools = (isPrompt ? a.prompt?.tools : a.config?.mcpTools) ?? [];
  const project = workspaceId
    ? `${projects.find((p) => p.id === workspaceId)?.name ?? "A project that is not open"}${openPane ? " · opens a pane" : ""}`
    : ((isPrompt ? a.prompt?.workdir : a.config?.workdir) ?? "Background");
  const facts: Facts = [
    ["Agent", preset?.name ?? (presetId ? "Missing agent — choose one" : "No agent")],
    ["Project", project],
    ["Tools", tools.length ? tools.join(", ") : isPrompt ? "The agent's own" : "Read-only"],
  ];
  const account = a.prompt?.account ?? a.config?.account;
  if (!isPrompt && account) facts.push(["Posts as", account]);
  return facts;
}
