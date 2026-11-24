"use client";

import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { useLotusSettings } from "@/modules/lotus-settings/lotus-settings-context";
import type { Automation, AutomationClient, AutomationRun } from "../services/automation-api";
import { formatShortWhen } from "../services/format";

/**
 * Inbox's "Needs attention" (mockups/automation-agent-health.html, view 1): one card per automation
 * whose last run failed, with the one button that fixes that kind of failure. The raw error stays
 * behind Details.
 */
export function NeedsAttention({
  items,
  client,
  onOpenAutomation,
}: {
  items: { automation: Automation; run: AutomationRun }[];
  client: AutomationClient;
  onOpenAutomation?: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="au-attention" className="au-inbox-group">
      <div className="au-group-head">
        <h2 id="au-attention" className="au-group-title">
          Needs attention <span className="rs-tab-count">{items.length}</span>
        </h2>
      </div>
      <ul className="au-attention">
        {items.map(({ automation, run }) => (
          <AttentionCard key={automation.id} automation={automation} run={run} client={client} onOpenAutomation={onOpenAutomation} />
        ))}
      </ul>
    </section>
  );
}

function AttentionCard({
  automation: a,
  run,
  client,
  onOpenAutomation,
}: {
  automation: Automation;
  run: AutomationRun;
  client: AutomationClient;
  onOpenAutomation?: (id: string) => void;
}) {
  const { openSettings } = useLotusSettings();
  const [note, setNote] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const canRunNow = a.actionKind === "agent_prompt";
  const open = () => onOpenAutomation?.(a.id);
  const runAgain = () =>
    client
      .runScheduledNow(a.id)
      .then(() => setNote("Run started."))
      .catch((e: unknown) => setNote(String(e)));

  const fix: [string, () => void] | null = (() => {
    switch (run.failure) {
      case "login_expired":
        return ["Sign in again", () => openSettings({ section: "accounts" })];
      case "agent_missing":
      case "preset_missing":
      case "account_missing":
        return onOpenAutomation ? ["Choose another agent", open] : null;
      default:
        return canRunNow ? ["Run again", () => void runAgain()] : onOpenAutomation ? ["Open", open] : null;
    }
  })();

  return (
    <li className="au-attention-card">
      <CircleAlert size={15} className="au-attention-icon" aria-hidden />
      <div className="au-attention-body">
        <div className="au-attention-head">
          <strong>{a.name}</strong>
          <span className="au-hint">
            {a.enabled ? "failed" : "paused after failing"} · {formatShortWhen(run.createdAtMs)}
          </span>
        </div>
        <p className="au-attention-text">{run.advice ?? run.detail ?? "The last run failed."}</p>
        {details && run.detail ? <p className="au-hint au-attention-raw">{run.detail}</p> : null}
        {note ? <p className="au-hint">{note}</p> : null}
      </div>
      <div className="au-attention-actions">
        {run.advice && run.detail ? (
          <button type="button" className="au-link" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
            Details
          </button>
        ) : null}
        {fix ? (
          <button type="button" className="au-chip" onClick={fix[1]}>
            {fix[0]}
          </button>
        ) : null}
      </div>
    </li>
  );
}
