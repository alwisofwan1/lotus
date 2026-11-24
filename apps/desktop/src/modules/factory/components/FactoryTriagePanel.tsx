"use client";

import type { FactoryTriage } from "@/lib/tauri/graph-run";
import { DetailSection } from "@/components/resource/resource-kit";
import { triageBlock } from "../services/factory-run";
import { SCORE_LABEL, VERDICT_LABEL, duplicateRows, readinessRows } from "../services/factory-triage";

/**
 * What triage found (FI3): size, score, verdict and reason, the nine readiness ratings, and any
 * work on the issue that already exists. While triage stops the run, "Continue anyway" lets it go
 * on; Abort is in the header.
 */
export function FactoryTriagePanel({
  triage,
  repo,
  busy,
  proceed,
  openUrl,
}: {
  triage: FactoryTriage;
  repo: string;
  busy: boolean;
  proceed: () => void;
  openUrl: (url: string) => void;
}) {
  const block = triageBlock(triage);
  const report = triage.report;
  const duplicates = duplicateRows(triage, repo);

  return (
    <DetailSection title="Triage">
      <div className="fa-triage">
        {duplicates.length > 0 ? (
          <div className="fa-triage-block">
            <p className="fa-triage-head">Work on this issue already exists{triage.duplicatesAccepted ? " (you continued anyway)" : ""}</p>
            <ul className="fa-triage-list">
              {duplicates.map((d) => (
                <li key={d.label}>
                  <button type="button" className="fa-link" onClick={() => openUrl(d.url)}>
                    {d.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {report ? (
          <>
            <dl className="fa-triage-facts">
              <dt>Size</dt>
              <dd>{report.size}</dd>
              <dt>Readiness</dt>
              <dd data-score={report.score}>{SCORE_LABEL[report.score]}</dd>
              <dt>Verdict</dt>
              <dd>
                {VERDICT_LABEL[report.verdict]}
                {report.verdict === "refuse" && triage.refusalOverridden ? " (you continued anyway)" : ""}
              </dd>
            </dl>
            <p className="fa-summary">{report.reason}</p>
            <table className="fa-readiness">
              <tbody>
                {readinessRows(report).map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td data-level={row.level}>{row.levelLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report.files.length > 0 ? (
              <details className="fa-full">
                <summary>Files it would touch ({report.files.length})</summary>
                <ul className="fa-triage-list fa-mono">
                  {report.files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <p className="fa-note">Written by the triage agent, not verified. Lotus scores the nine ratings.</p>
          </>
        ) : null}

        {triage.labels.length > 0 ? <p className="fa-note">Labels: {triage.labels.join(", ")}</p> : null}
        {triage.notes.map((note) => (
          <p key={note} className="fa-note">
            Not checked: {note}
          </p>
        ))}

        {block === "multi-repo" ? (
          <p className="fa-note">
            Multi-repo is not supported yet: triage routed this to {(report?.repos ?? []).join(" and ")}. Abort the run and split the ticket.
          </p>
        ) : block ? (
          <div className="fa-intake-actions">
            <button type="button" className="rs-button rs-button--primary" disabled={busy} onClick={proceed}>
              Continue anyway
            </button>
            <span className="fa-note">
              {block === "duplicates" ? "The triage agent then reads the ticket." : "The spec agent then starts on the ticket."}
            </span>
          </div>
        ) : null}
      </div>
    </DetailSection>
  );
}
