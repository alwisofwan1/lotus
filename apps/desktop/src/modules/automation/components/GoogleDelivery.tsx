"use client";

import { ExternalLink, FileText, RotateCw, Table } from "lucide-react";
import { useState } from "react";

import { Pill } from "@/components/resource/resource-kit";

import type { AutomationClient, GoogleDelivery as Delivery, GoogleOutput } from "../services/automation-api";

/**
 * Where a scheduled prompt's result went in Google: the Sheet's new rows and the Drive file
 * (plans/google-connector G12, G13). A write that did not go out says why, and "Send again to
 * Google" repeats only that write — never the agent, so no row is ever added twice.
 */
export function GoogleDelivery({
  draftId,
  google,
  client,
}: {
  draftId: string;
  google: Delivery;
  client: AutomationClient;
}) {
  const [state, setState] = useState<"idle" | "sending" | { error: string }>("idle");
  const parts: [string, GoogleOutput, typeof Table, string][] = [];
  if (google.sheet) parts.push(["Google Sheet", google.sheet, Table, "Open sheet"]);
  if (google.drive) parts.push(["Google Drive", google.drive, FileText, "Open file"]);
  if (parts.length === 0) return null;
  const failed = parts.filter(([, o]) => o.status === "not_sent");
  const reconnect = failed.some(([, o]) => o.reconnect);

  const resend = async () => {
    setState("sending");
    try {
      await client.resendGoogle(draftId);
      setState("idle");
    } catch (e) {
      setState({ error: String(e) });
    }
  };

  return (
    <section className="au-google" aria-label="Sent to Google">
      <ul className="au-google-list">
        {parts.map(([label, output, Icon, open]) => (
          <li key={label} className="au-google-row" data-status={output.status} aria-label={label}>
            <Icon size={14} strokeWidth={1.75} aria-hidden />
            <span className="au-google-text">
              <span className="au-google-name">{label}</span>
              {output.detail ? <span className="au-google-detail">{output.detail}</span> : null}
            </span>
            <Pill tone={output.status === "sent" ? "ok" : "danger"}>{output.status === "sent" ? "Sent" : "Not sent"}</Pill>
            {output.status === "sent" && output.url ? (
              <a className="rs-button rs-button--ghost" href={output.url} target="_blank" rel="noreferrer">
                <ExternalLink size={12} aria-hidden />
                {open}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      {failed.length > 0 ? (
        <footer className="au-google-foot">
          <span className="au-note">
            {reconnect
              ? "Connect Google in Connectors first, then send again."
              : "Only the Google write runs again. The agent does not, so no row is added twice."}
          </span>
          <button type="button" className="rs-button rs-button--primary" disabled={state === "sending"} onClick={() => void resend()}>
            <RotateCw size={12} aria-hidden />
            {state === "sending" ? "Sending…" : "Send again to Google"}
          </button>
        </footer>
      ) : null}
      {typeof state === "object" ? (
        <p className="au-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
