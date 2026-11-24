"use client";

import { Check, Folder, GitBranch } from "lucide-react";
import { useState, type ReactNode } from "react";

import { resetIn, usageTone, windowLabel, windowPace, type UsageAccount } from "@/modules/workspace-shell/services/usage";

import { compactCount, contextSummary } from "../domain/context";
import { permissionLabel } from "../domain/permissions";
import type { PlanTask } from "../domain/plan";
import { requestTitle } from "../domain/requests";
import type { ThreadState } from "../domain/thread-state";
import { effortName, modelName } from "./ChatModel";

// The Workbench's Context tab (plans/chat-right-sidebar, M3): everything about this chat in one
// read-only place. Layout: mockups/chat-context-pane.html, proposal A.

interface ContextPaneProps {
  state: ThreadState | null;
  cwd: string;
  branch: string | null;
  model: string | null;
  /** The model as its runner's list names it; falls back to a name read off the id. */
  modelLabel?: string | null;
  effort: string | null;
  /** "Claude login", "API key", …; null when unknown. */
  login: string | null;
  permission: string | null;
  /** The ccs account this chat runs on, with its limits; null outside Claude. */
  account: UsageAccount | null;
  accountName: string | null;
  plan: readonly PlanTask[] | null;
}

const BYPASS = permissionLabel("bypassPermissions");

export function ContextPane({ state, cwd, branch, model, modelLabel = null, effort, login, permission, account, accountName, plan }: ContextPaneProps) {
  const s = contextSummary(state);
  // Reset times are read against the moment the tab opened; minutes of drift are fine here.
  const [now] = useState(Date.now);
  const slash = cwd.replace(/\/+$/, "").lastIndexOf("/");
  const [dir, leaf] = slash > 0 ? [cwd.slice(0, slash + 1), cwd.slice(slash + 1).replace(/\/+$/, "")] : ["", cwd];
  // A login's cost is what the turns would have cost at API rates; only an API key is billed.
  const billed = login === "API key";
  return (
    <div className="chat-context">
      {s.waiting.length > 0 && (
        <Section title={`Waiting on you · ${s.waiting.length}`} tone="warn">
          <ul className="chat-context-waiting">
            {s.waiting.map((w) => (
              <li key={w.interaction.id}>{requestTitle(w.interaction)}</li>
            ))}
          </ul>
        </Section>
      )}

      <div className="chat-context-hero">
        <div className="chat-context-model" title={model ?? undefined}>
          <strong>{modelLabel ?? modelName([], model) ?? "Default model"}</strong>
          {effort && <span> · {effortName(effort)} effort</span>}
        </div>
        <div className="chat-context-path" title={cwd}>
          <Folder size={12} aria-hidden />
          {/* rtl cuts the start of the path, so the folder name survives a narrow pane; lrm keeps the slashes in place. */}
          <span className="chat-context-dir">{`‎${dir}‎`}</span>
          <span className="chat-context-leaf">{leaf}</span>
          <button type="button" className="chat-context-copy" onClick={() => void navigator.clipboard?.writeText(cwd)}>
            Copy
          </button>
        </div>
        <div className="chat-context-chips">
          {branch && (
            <span className="chat-context-chip" data-mono>
              <GitBranch size={11} aria-hidden />
              {branch}
            </span>
          )}
          {(accountName || login) && <span className="chat-context-chip">{[accountName, login].filter(Boolean).join(" · ")}</span>}
          {permission && (
            <span className="chat-context-chip" data-tone={permission === BYPASS ? "warn" : undefined} title={permission === BYPASS ? "Runs every tool without asking" : undefined}>
              {permission}
            </span>
          )}
        </div>
      </div>

      {account && (
        <Section title="Limits">
          {account.error ? (
            <p className="chat-context-empty">{account.error}</p>
          ) : (
            account.windows.map((w) => {
              const tone = usageTone(w.usedPercent);
              const pace = windowPace(w, now);
              const reset = resetIn(w.resetsAtMs, now);
              return (
                <div key={w.kind} className="chat-context-limit" data-tone={tone}>
                  <div className="chat-context-limit-head">
                    <span>{windowLabel(w)}</span>
                    <strong>{Math.round(w.usedPercent)}%</strong>
                    {reset && <span className="chat-context-quiet">· resets {reset}</span>}
                  </div>
                  <span className="chat-context-meter" role="meter" aria-label={`${windowLabel(w)} used`} aria-valuenow={Math.round(w.usedPercent)} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
                    {pace !== null && tone !== "full" && <i style={{ left: `${pace * 100}%` }} aria-hidden />}
                  </span>
                  {tone === "full" ? (
                    <span className="chat-context-note" data-tone="full">Limit reached: replies pause until reset</span>
                  ) : pace !== null && w.usedPercent / 100 > pace && (
                    // Only the exception speaks; "On pace" on every row was noise.
                    <span className="chat-context-note" data-tone="warn">
                      Ahead of pace: {Math.round(pace * 100)}% of the window has passed
                    </span>
                  )}
                </div>
              );
            })
          )}
        </Section>
      )}

      <Section title="This chat" aside={s.last ? `${s.turns} ${s.turns === 1 ? "turn" : "turns"}` : undefined}>
        {s.last ? (
          <>
            {s.window && (
              <div className="chat-context-limit" data-tone={usageTone((s.window.used / s.window.size) * 100)}>
                <div className="chat-context-limit-head">
                  <span>Context window</span>
                  <strong>{Math.round((s.window.used / s.window.size) * 100)}%</strong>
                  <span className="chat-context-quiet">· {compactCount(s.window.used)} of {compactCount(s.window.size)}</span>
                </div>
                <span className="chat-context-meter" role="meter" aria-label="Context window used" aria-valuenow={Math.round((s.window.used / s.window.size) * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${Math.min(100, (s.window.used / s.window.size) * 100)}%` }} />
                </span>
              </div>
            )}
            <div className="chat-context-stats">
              <Stat value={compactCount(s.inputTokens)} label="tokens in" />
              <Stat value={compactCount(s.outputTokens)} label="tokens out" />
              {s.costUsd !== null && (
                <Stat
                  value={`$${s.costUsd.toFixed(s.costUsd < 1 ? 3 : 2)}`}
                  label={billed ? "cost" : "API equiv."}
                  hint={billed ? undefined : "Not charged: your login covers it. This is the price at API rates."}
                />
              )}
              {s.last.durationMs ? <Stat value={`${(s.last.durationMs / 1000).toFixed(1)}s`} label="last reply" /> : null}
            </div>
            {/* Claude sums a turn's calls here, Codex reports its last call: no caveat fits both, the gauge carries the meaning. */}
            <p className="chat-context-sub">
              Last reply {compactCount(s.last.inputTokens)} in · {compactCount(s.last.outputTokens)} out
            </p>
          </>
        ) : (
          <p className="chat-context-empty">Nothing yet: usage shows after the first reply</p>
        )}
      </Section>

      {plan && plan.length > 0 && (
        <Section title="Plan" aside={`${plan.filter((t) => t.status === "done").length}/${plan.length}`}>
          <ol className="chat-plan-list chat-context-plan">
            {plan.map((task, i) => (
              <li key={i} data-status={task.status}>
                <span className="chat-plan-tick" aria-hidden>
                  {task.status === "done" && <Check size={8} strokeWidth={3.5} />}
                </span>
                <span>{task.status === "active" ? task.activeForm : task.content}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}
    </div>
  );
}

function Section({ title, aside, tone, children }: { title: string; aside?: string; tone?: "warn"; children: ReactNode }) {
  return (
    <section className="chat-context-section" data-tone={tone}>
      <h3>
        <span>{title}</span>
        {aside && <span className="chat-context-quiet">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

function Stat({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="chat-context-stat">
      <strong>{value}</strong>
      <span title={hint} data-hint={hint ? true : undefined}>
        {label}
      </span>
    </div>
  );
}
