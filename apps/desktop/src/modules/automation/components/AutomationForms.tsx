"use client";

import { MessageSquare } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import type {
  AgentPreset,
  AgentPromptForm,
  Automation,
  AutomationClient,
  AutomationProject,
  GhAccount,
  GoogleAccountState,
  PrReviewForm,
  SlackChannel,
} from "../services/automation-api";
import { describeCron, splitSimpleCron } from "../services/format";
import { parseAgentRef } from "../services/agent-ref";
import { AgentField } from "./AgentField";
import { GoogleOutputFields, googleForm, initialGoogleOutputs } from "./GoogleOutputFields";
import { ReplyStyleHint, SlackReplyPreview } from "./ReplyStyleHint";

/**
 * The two ways to write an automation by hand, for "New …" and for "Edit settings". Each opens
 * on what matters (the prompt, the repositories) with sensible defaults, and keeps the rest under
 * Advanced. Editing keeps whether the automation is on; the engine decides nothing else changed.
 */

const DAYS: { key: string; label: string }[] = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const toggle = (list: string[], value: string) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/** A bare name is a whole organization (`acme` → `acme/*`); `owner/name` is one repository. */
export function parseScope(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, ""))
    .filter(Boolean)
    .map((part) => (part.includes("/") ? part : `${part}/*`));
}

const scopeText = (repos: string[]) => repos.map((r) => (r.endsWith("/*") ? r.slice(0, -2) : r)).join(", ");

/**
 * The project a run works in: its folder (for a review, the checkout of the PR's repo inside it).
 * Runs stay in the background, where nothing waits on the user, and each one's steps show under
 * Runs; a pane to watch it is a choice, because a pane stops to ask before a tool off its list.
 */
function ProjectSelect({
  projects,
  value,
  onChange,
  openPane,
  onOpenPaneChange,
}: {
  projects: AutomationProject[];
  value: string;
  onChange: (id: string) => void;
  openPane: boolean;
  onOpenPaneChange: (open: boolean) => void;
}) {
  const missing = value !== "" && !projects.some((p) => p.id === value);
  return (
    <>
      <Field
        label="Project"
        hint="Each run works in this project's folder (a review: in the checkout of its repo), in the background. None: in its own empty folder."
      >
        <select className="au-input" aria-label="Project" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">None</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {missing ? <option value={value}>A project that is not open ({value})</option> : null}
        </select>
      </Field>
      {value !== "" ? (
        <Field
          label="Watch"
          hint="Off: follow each run's steps under Runs, and open its conversation from there afterwards. On: a pane opens in the project, and it may stop to ask you to allow a tool."
        >
          <label className="au-check">
            <input type="checkbox" checked={openPane} onChange={(e) => onOpenPaneChange(e.target.checked)} />
            Open a pane to watch each run
          </label>
        </Field>
      ) : null}
    </>
  );
}

function FormSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="au-fsection">
      <legend className="au-fsection-title">{title}</legend>
      {hint ? <p className="au-fsection-hint">{hint}</p> : null}
      <div className="au-fsection-body">{children}</div>
    </fieldset>
  );
}

/** The hint sits outside the `<label>`, so a control's name is its label and nothing more. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="au-field">
      <label className="au-field">
        <span className="au-label">{label}</span>
        {children}
      </label>
      {hint ? <span className="au-hint">{hint}</span> : null}
    </div>
  );
}

function Advanced({ children }: { children: ReactNode }) {
  return (
    <details className="au-advanced">
      <summary>Advanced</summary>
      <div className="au-advanced-body">{children}</div>
    </details>
  );
}

function FormFoot({
  error,
  submitLabel,
  canSubmit,
  busy,
  onCancel,
  note,
}: {
  error: string | null;
  submitLabel: string;
  canSubmit: boolean;
  busy: boolean;
  onCancel: () => void;
  note?: string;
}) {
  return (
    <>
      {error ? (
        <p className="au-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="au-form-foot">
        {note ? <span className="au-note">{note}</span> : <span />}
        <span className="au-draft-actions">
          <button type="button" className="rs-button rs-button--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="rs-button rs-button--primary" disabled={!canSubmit || busy}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </span>
      </div>
    </>
  );
}

function AccountSelect({ accounts, value, onChange }: { accounts: GhAccount[]; value: string; onChange: (v: string) => void }) {
  return (
    <select className="au-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {accounts.map((a) => (
        <option key={a.login} value={a.login}>
          {a.login}
          {a.active ? " (active in gh)" : ""}
        </option>
      ))}
    </select>
  );
}

// ── Scheduled prompt ──────────────────────────────────────────────────────────

export function ScheduledPromptForm({
  client,
  presets,
  accounts,
  slackConnected,
  initial,
  projects = [],
  onSaved,
  onCancel,
}: {
  client: AutomationClient;
  presets: AgentPreset[];
  accounts: GhAccount[];
  slackConnected: boolean;
  /** Present when editing. */
  initial?: Automation;
  /** The window's workspaces, offered as the project a run opens its pane in. */
  projects?: AutomationProject[];
  onSaved: (automation: Automation) => void;
  onCancel: () => void;
}) {
  const p = initial?.prompt;
  const simple = initial?.schedule ? splitSimpleCron(initial.schedule.cron) : null;
  const [prompt, setPrompt] = useState(p?.prompt ?? "");
  const [days, setDays] = useState<string[]>(simple?.days ?? ["mon", "tue", "wed", "thu", "fri"]);
  const [time, setTime] = useState(simple?.time ?? "09:00");
  const [cron, setCron] = useState(initial?.schedule && !simple ? initial.schedule.cron : "");
  const [timezone, setTimezone] = useState(initial?.schedule?.timezone ?? localTimeZone());
  const [reviewQueue, setReviewQueue] = useState(p?.includeReviewRequests ?? true);
  const [dmSelf, setDmSelf] = useState(p?.dmSelf ?? slackConnected);
  const [channel, setChannel] = useState(p?.slackChannel ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [account, setAccount] = useState<string | null>(p?.account ?? null);
  const [presetId, setPresetId] = useState<string | null>(p?.presetId ?? null);
  const [scope, setScope] = useState(scopeText(p?.repos ?? []));
  const [team, setTeam] = useState(p?.reviewerTeam ?? "");
  const [workspaceId, setWorkspaceId] = useState(p?.workspaceId ?? "");
  const [openPane, setOpenPane] = useState(p?.openPane ?? false);
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [google, setGoogle] = useState(() => initialGoogleOutputs(p?.googleSheet, p?.googleDrive));
  const [googleAccount, setGoogleAccount] = useState<GoogleAccountState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void client
      .googleStatus()
      .then((g) => alive && setGoogleAccount(g))
      .catch(() => alive && setGoogleAccount(null));
    return () => {
      alive = false;
    };
  }, [client]);

  useEffect(() => {
    if (!slackConnected) return;
    let alive = true;
    void client
      .slackChannels()
      .then((c) => alive && setChannels(c))
      .catch(() => alive && setChannels([]));
    return () => {
      alive = false;
    };
  }, [client, slackConnected]);

  const chosenAccount = account ?? accounts.find((a) => a.active)?.login ?? accounts[0]?.login ?? "";
  const chosenPreset = presetId ?? presets.find((x) => x.supported)?.id ?? "";
  const runnable = presets.find((x) => x.id === parseAgentRef(chosenPreset).presetId && x.supported);
  const cronText = cron.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const form: AgentPromptForm = {
      name: name.trim(),
      prompt: prompt.trim(),
      presetId: chosenPreset,
      days,
      time,
      timezone,
      cron: cronText || null,
      // Kept for older automations; a run now has every tool (2026-09-25).
      tools: [],
      // Kept as it was: a run with a project works in the project's folder, and the form no longer asks.
      workdir: p?.workdir ?? null,
      workspaceId: workspaceId || null,
      openPane: Boolean(workspaceId) && openPane,
      account: chosenAccount || null,
      repos: parseScope(scope),
      reviewerTeam: team.trim() || null,
      includeReviewRequests: reviewQueue,
      dmSelf,
      slackChannel: channel || null,
      ...googleForm(google),
    };
    try {
      onSaved(initial ? await client.edit(initial.id, "agent_prompt", form) : await client.createAgentPrompt(form));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="au-form" aria-label={initial ? "Edit scheduled prompt" : "New scheduled prompt"} onSubmit={(e) => void submit(e)}>
      <FormSection
        title="Prompt"
        hint="Runs like any agent you start: the preset's permissions, every tool, your skills, settings and MCP servers."
      >
        <textarea
          className="au-textarea au-textarea--prompt"
          aria-label="Prompt"
          rows={5}
          placeholder="Summarize the PRs waiting for my review, most urgent first."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <label className="au-check">
          <input type="checkbox" checked={reviewQueue} onChange={(e) => setReviewQueue(e.target.checked)} />
          Give it the PRs waiting for my review
        </label>
        <ProjectSelect
          projects={projects}
          value={workspaceId}
          onChange={setWorkspaceId}
          openPane={openPane}
          onOpenPaneChange={setOpenPane}
        />
      </FormSection>

      <FormSection title="Agent" hint="Who does the work. Pick the model, effort and Claude account here; save the mix as a new agent to reuse it.">
        <AgentField presets={presets} value={chosenPreset} onChange={setPresetId} />
      </FormSection>

      <FormSection title="Schedule">
        {cronText ? (
          <p className="au-note">
            Custom pattern <code>{cronText}</code> ({describeCron(cronText)}). Clear it under Advanced to pick days again.
          </p>
        ) : (
          <div className="au-schedule">
            <div className="au-daypicker" role="group" aria-label="Days">
              {DAYS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  className="au-day"
                  aria-pressed={days.includes(d.key)}
                  onClick={() => setDays((l) => toggle(l, d.key))}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <input className="au-input au-input--time" type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} />
            <span className="au-note">{timezone}</span>
          </div>
        )}
      </FormSection>

      <FormSection title="Deliver to">
        {/* A card like each Google output below it: every destination is one row of the same shape. */}
        <div className="au-gblock" data-on={dmSelf || undefined}>
          <label className="au-check">
            <input type="checkbox" checked={dmSelf} disabled={!slackConnected} onChange={(e) => setDmSelf(e.target.checked)} />
            <MessageSquare size={14} strokeWidth={1.75} aria-hidden />
            My Slack DM, sent automatically
            {slackConnected ? null : <span className="au-note">(connect Slack in Connectors first)</span>}
          </label>
        </div>
        {slackConnected ? (
          <Field label="Also a channel" hint="A channel post always waits in Inbox until you press Send.">
            <select className="au-input" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">No channel</option>
              {(channels ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.isPrivate ? "🔒 " : "#"}
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <GoogleOutputFields
          google={googleAccount}
          value={google}
          onChange={setGoogle}
          fileStem={name.trim() || prompt.split("\n")[0].slice(0, 60)}
          picker={{ pick: (kind) => client.googlePick(kind), cancel: () => client.googleCancelPick() }}
        />
        <p className="au-note">
          Google gets the result right after each run, like your DM. Every result also lands in Inbox, with a macOS
          notification.
        </p>
      </FormSection>

      <Advanced>
        <Field label="Name">
          <input className="au-input" placeholder="The prompt's first line" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="GitHub account">
          <AccountSelect accounts={accounts} value={chosenAccount} onChange={setAccount} />
        </Field>
        <Field label="Only these organizations or repositories" hint="Empty: every repository the account can see.">
          <input className="au-input" placeholder="acme, owner/repo" value={scope} onChange={(e) => setScope(e.target.value)} />
        </Field>
        <Field label="GitHub team" hint="Its review requests count as yours.">
          <input className="au-input" placeholder="org/team-slug" value={team} onChange={(e) => setTeam(e.target.value)} />
        </Field>
        <Field label="Time zone">
          <input className="au-input" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
        <Field label="Cron pattern" hint="Overrides the days and time above.">
          <input className="au-input au-input--mono" placeholder="0 9 * * 1-5" value={cron} onChange={(e) => setCron(e.target.value)} />
        </Field>
      </Advanced>

      <FormFoot
        error={error}
        busy={busy}
        onCancel={onCancel}
        canSubmit={Boolean(prompt.trim() && runnable && (cronText || days.length))}
        submitLabel={initial ? "Save changes" : "Create automation"}
        note={runnable ? `${runnable.name} · ${chosenAccount || "no GitHub account"}` : "Choose an agent that can run here."}
      />
    </form>
  );
}

// ── PR review ─────────────────────────────────────────────────────────────────

function defaultName(scope: string[]): string {
  const shown = scope.map((entry) => (entry.endsWith("/*") ? entry.slice(0, -2) : entry));
  return shown.length > 0 ? `PR review · ${shown.join(", ")}` : "PR review";
}

export function PrReviewForm({
  client,
  presets,
  accounts,
  initial,
  projects = [],
  onSaved,
  onCancel,
}: {
  client: AutomationClient;
  presets: AgentPreset[];
  accounts: GhAccount[];
  initial?: Automation;
  /** The window's workspaces, offered as the project a review opens its pane in. */
  projects?: AutomationProject[];
  onSaved: (automation: Automation) => void;
  onCancel: () => void;
}) {
  const c = initial?.config;
  const [scope, setScope] = useState(scopeText(c?.repos ?? []));
  const [name, setName] = useState(initial?.name ?? "");
  const [account, setAccount] = useState<string | null>(c?.account ?? null);
  const [presetId, setPresetId] = useState<string | null>(c?.presetId ?? null);
  const [instructions, setInstructions] = useState(c?.instructions ?? "");
  const [workspaceId, setWorkspaceId] = useState(c?.workspaceId ?? "");
  const [openPane, setOpenPane] = useState(c?.openPane ?? false);
  const [mcpTools, setMcpTools] = useState((c?.mcpTools ?? []).join(", "));
  const [skill, setSkill] = useState(c?.skill ?? "");
  const [maxFiles, setMaxFiles] = useState(c?.maxFiles ? String(c.maxFiles) : "");
  const [timeoutMinutes, setTimeoutMinutes] = useState(c?.timeoutMinutes ? String(c.timeoutMinutes) : "");
  const [runTests, setRunTests] = useState(c?.runTests ?? false);
  const [autoSend, setAutoSend] = useState(c?.autoSend ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chosenAccount = account ?? accounts.find((a) => a.active)?.login ?? accounts[0]?.login ?? "";
  const chosenPreset = presetId ?? presets.find((p) => p.supported)?.id ?? "";
  const runnable = presets.find((p) => p.id === parseAgentRef(chosenPreset).presetId && p.supported);
  const repos = parseScope(scope);
  const missing = !chosenAccount
    ? "No gh account is logged in. Run `gh auth login` first."
    : !runnable
      ? "Choose an agent that can run here (a Claude agent)."
      : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    for (const [field, text] of [["max files", maxFiles], ["timeout", timeoutMinutes]]) {
      if (Number.isNaN(wholeNumber(text))) return setError(`${field}: ${JSON.stringify(text.trim())} is not a whole number`);
    }
    setBusy(true);
    const form: PrReviewForm = {
      name: name.trim() || defaultName(repos),
      account: chosenAccount,
      presetId: chosenPreset,
      repos,
      instructions: instructions.trim(),
      // Kept as it was: a review with a project works in the project's checkout.
      workdir: c?.workdir ?? null,
      workspaceId: workspaceId || null,
      openPane: Boolean(workspaceId) && openPane,
      mcpTools: mcpTools
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean),
      skill: skill.trim().replace(/^\/+/, "") || null,
      maxFiles: wholeNumber(maxFiles),
      timeoutMinutes: wholeNumber(timeoutMinutes),
      runTests,
      autoSend,
    };
    try {
      onSaved(initial ? await client.edit(initial.id, "pr_review", form) : await client.createPrReview(form));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="au-form" aria-label={initial ? "Edit PR review" : "New PR review"} onSubmit={(e) => void submit(e)}>
      <FormSection
        title="Repositories"
        hint="PRs you are asked to review in Slack or on GitHub, or start with Review, are reviewed. Reviews are drafts until you press Send."
      >
        <input
          className="au-input"
          aria-label="Organization or repositories"
          placeholder="acme, or owner/repo separated by commas"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        />
        <span className="au-hint">An organization covers all its repositories, including new ones.</span>
      </FormSection>

      <FormSection title="Agent" hint="Who does the work. Pick the model, effort and Claude account here; save the mix as a new agent to reuse it.">
        <AgentField presets={presets} value={chosenPreset} onChange={setPresetId} />
      </FormSection>

      <FormSection
        title="Review instructions"
        hint="Optional. The repository's own .github/REVIEW.md or CLAUDE.md is read too. The reviewer reads other people's code, so it only reads: files, search, the PR and git history, your skills, and the MCP tools you list under Advanced."
      >
        <textarea
          className="au-textarea au-textarea--prompt"
          aria-label="Instructions"
          rows={4}
          placeholder="Focus on correctness and security. Skip style nitpicks."
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <ReplyStyleHint value={instructions} onChange={setInstructions} />
        <SlackReplyPreview instructions={instructions} />
        <ProjectSelect
          projects={projects}
          value={workspaceId}
          onChange={setWorkspaceId}
          openPane={openPane}
          onOpenPaneChange={setOpenPane}
        />
      </FormSection>

      <Advanced>
        <Field label="Name">
          <input className="au-input" placeholder={defaultName(repos)} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="GitHub account" hint="The review is posted as this account.">
          <AccountSelect accounts={accounts} value={chosenAccount} onChange={setAccount} />
        </Field>
        <Field
          label="MCP tools"
          hint="Optional. MCP tools the reviewer may use, e.g. mcp__context7 (a whole server) or mcp__server__tool. List only tools that read: a PR's text could ask for the rest."
        >
          <input
            className="au-input"
            placeholder="mcp__context7"
            value={mcpTools}
            onChange={(e) => setMcpTools(e.target.value)}
          />
        </Field>
        <Field
          label="Skill"
          hint="Optional. Your skill the reviewer follows instead of Lotus's review method, e.g. code-review or plugin:code-review. It must be in ~/.claude/skills or an enabled plugin; a missing one fails the run."
        >
          <input className="au-input" placeholder="code-review" value={skill} onChange={(e) => setSkill(e.target.value)} />
        </Field>
        <Field label="Max files" hint="A PR that changes more files is skipped. Empty: 300.">
          <input
            className="au-input"
            inputMode="numeric"
            placeholder="300"
            value={maxFiles}
            onChange={(e) => setMaxFiles(e.target.value)}
          />
        </Field>
        <Field label="Timeout (minutes)" hint="How long a review without a pane may take. Empty: 30.">
          <input
            className="au-input"
            inputMode="numeric"
            placeholder="30"
            value={timeoutMinutes}
            onChange={(e) => setTimeoutMinutes(e.target.value)}
          />
        </Field>
        <Field
          label="Tests"
          hint="Off: the reviewer reads the tests but does not run them. On: a review without a pane may install dependencies and run the PR's tests in its own folder. It reaches the npm and PyPI registries only, reads only its own folder and your toolchains, and gets none of your environment variables."
        >
          <label className="au-check">
            <input type="checkbox" checked={runTests} onChange={(e) => setRunTests(e.target.checked)} />
            Run the PR's tests
          </label>
          {runTests ? (
            <p className="au-callout au-callout--warn" role="note">
              The PR's code runs on this Mac. Lotus closes your home folder and your tokens to it, but npm can still
              publish what the review folder holds. Turn this on only for repositories whose authors you trust.
            </p>
          ) : null}
        </Field>
        <Field
          label="Auto mode"
          hint="Off: each review waits for you to press Send. On: Lotus posts it on GitHub and replies in Slack when the review finishes."
        >
          <label className="au-check">
            <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
            Post reviews without Send
          </label>
          {autoSend ? (
            <p className="au-callout au-callout--warn" role="note">
              Lotus posts as {chosenAccount || "your account"}. Lotus picks the GitHub action, not the agent: a blocker or
              should-fix requests changes, questions comment, and a clean review approves. A review with partial coverage,
              or a PR that moved during it, waits for you. When a later round finds nothing that must change, Lotus
              dismisses its own earlier Request changes.
            </p>
          ) : null}
        </Field>
      </Advanced>

      <FormFoot
        error={error}
        busy={busy}
        onCancel={onCancel}
        canSubmit={repos.length > 0 && missing === null}
        submitLabel={initial ? "Save changes" : "Create automation"}
        note={missing ?? `as ${chosenAccount} · ${runnable?.name ?? chosenPreset}`}
      />
    </form>
  );
}

/** A whole number typed in a field, null when empty, NaN when it is not one (the backend checks the range). */
function wholeNumber(text: string): number | null {
  const t = text.trim();
  return t === "" ? null : /^\d+$/.test(t) ? Number(t) : NaN;
}
