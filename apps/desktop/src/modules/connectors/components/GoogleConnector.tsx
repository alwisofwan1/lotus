"use client";

import { ExternalLink, FolderOpen, KeyRound, LoaderCircle, ShieldCheck, Table, Unplug } from "lucide-react";
import { useState } from "react";

import { DetailHeader, DetailSection, EmptyState } from "@/components/resource/resource-kit";
import { GoogleMark } from "@/components/icons/ServiceMarks";

import {
  describeGoogle,
  GOOGLE_CANCELLED,
  type AutomationUse,
  type ConnectorsClient,
  type GoogleStatus,
} from "../services/connectors-api";
import { HealthPill, UsedBy } from "./connector-parts";

/**
 * Google, connected with Lotus's own sign-in (plans/google-connector): one button, the system
 * browser, scope `drive.file` only. The refresh token goes to the Keychain through Rust and never
 * comes back here; this page only ever sees who is connected.
 */
export function GoogleConnector({
  client,
  status,
  usedBy,
}: {
  client: ConnectorsClient;
  status: GoogleStatus | null;
  usedBy: AutomationUse[];
}) {
  const { health, status: line } = describeGoogle(status);
  const state = status?.state ?? "not_connected";

  return (
    <>
      <DetailHeader
        icon={<GoogleMark size={16} />}
        title="Google"
        meta={
          <span className="cn-headmeta">
            <HealthPill health={health}>{line}</HealthPill>
          </span>
        }
      />

      {state === "unavailable" ? (
        <DetailSection title="Connect" id="cn-google-connect">
          <EmptyState>
            <strong>Not available in this build</strong>
            {status?.detail ?? "This build of Lotus has no Google client."}
          </EmptyState>
        </DetailSection>
      ) : state === "connected" ? (
        <GoogleConnection client={client} status={status} />
      ) : (
        <GoogleSetup client={client} waiting={state === "connecting"} />
      )}

      <DetailSection title="What Lotus can do" id="cn-google-does">
        <ul className="cn-points">
          <li>
            <Table size={15} strokeWidth={1.75} aria-hidden />
            Add rows to one Google Sheet after each run. Rows go to the end, like a log.
          </li>
          <li>
            <FolderOpen size={15} strokeWidth={1.75} aria-hidden />
            Save one report file per run into a Drive folder you choose.
          </li>
          <li>
            <ShieldCheck size={15} strokeWidth={1.75} aria-hidden />
            Touch only files Lotus made or you picked. Lotus cannot see the rest of your Drive.
          </li>
        </ul>
      </DetailSection>

      <UsedBy automations={usedBy} empty="No automation writes to Google yet." />
    </>
  );
}

function GoogleSetup({ client, waiting }: { client: ConnectorsClient; waiting: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.googleConnect();
    } catch (e) {
      const message = String(e);
      if (!message.includes(GOOGLE_CANCELLED)) setError(message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    client.googleCancelConnect().catch((e: unknown) => setError(String(e)));
  };

  if (busy || waiting) {
    return (
      <DetailSection title="Connect" id="cn-google-connect">
        <div className="au-callout cn-callout--busy" role="status">
          <LoaderCircle size={15} className="cn-spin" aria-hidden />
          <p>
            <strong>Waiting for your browser…</strong> Finish in the tab Lotus opened. This stops after 5 minutes.
          </p>
          <button type="button" className="rs-button rs-button--ghost" onClick={cancel}>
            Cancel
          </button>
        </div>
      </DetailSection>
    );
  }

  return (
    <DetailSection title="Connect" id="cn-google-connect">
      <div className="cn-connect-box">
        <div className="cn-connect-actions">
          <button type="button" className="rs-button rs-button--primary" onClick={() => void connect()}>
            <ExternalLink size={13} aria-hidden />
            Connect with Google
          </button>
          <span className="au-note">Opens your browser. No Google Cloud setup.</span>
        </div>
        <ol className="cn-steps cn-steps--compact">
          <li>
            <span className="cn-step-text">Your browser opens Google’s sign-in page.</span>
          </li>
          <li>
            <span className="cn-step-text">Pick an account, leave the Drive box ticked, then press Allow.</span>
          </li>
          <li>
            <span className="cn-step-text">Come back here. Lotus shows the account.</span>
          </li>
        </ol>
      </div>
      {error ? (
        <p className="au-error" role="alert">
          {error}
        </p>
      ) : null}
    </DetailSection>
  );
}

function GoogleConnection({ client, status }: { client: ConnectorsClient; status: GoogleStatus | null }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnect = () => {
    setError(null);
    client
      .googleDisconnect()
      .then(() => setConfirm(false))
      .catch((e: unknown) => setError(String(e)));
  };
  const since = status?.connectedAtMs
    ? new Date(status.connectedAtMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Unknown";

  return (
    <DetailSection
      title="Connection"
      id="cn-google-connection"
      actions={
        confirm ? null : (
          <button type="button" className="rs-button rs-button--ghost" onClick={() => setConfirm(true)}>
            <Unplug size={13} aria-hidden />
            Disconnect
          </button>
        )
      }
    >
      {confirm ? (
        <div className="au-callout au-callout--danger" role="alertdialog" aria-label="Disconnect Google">
          <p>
            Disconnect Google? Lotus ends its access at Google and deletes the sign-in from the Keychain. Your Sheets and
            Drive files stay.
          </p>
          <span className="au-draft-actions">
            <button type="button" className="rs-button rs-button--ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button type="button" className="rs-button rs-button--danger" onClick={disconnect}>
              Disconnect
            </button>
          </span>
        </div>
      ) : null}
      <div className="au-facts">
        <div className="au-fact">
          <span className="au-fact-label">Account</span>
          <span className="au-fact-value">{status?.email ?? "Unknown"}</span>
        </div>
        <div className="au-fact">
          <span className="au-fact-label">Access</span>
          <span className="au-fact-value">Only files Lotus made or you picked</span>
        </div>
        <div className="au-fact">
          <span className="au-fact-label">Token</span>
          <span className="au-fact-value">
            <KeyRound size={13} aria-hidden /> macOS Keychain, never sent to the agent
          </span>
        </div>
        <div className="au-fact">
          <span className="au-fact-label">Connected</span>
          <span className="au-fact-value">{since}</span>
        </div>
      </div>
      {error ? (
        <p className="au-error" role="alert">
          {error}
        </p>
      ) : null}
    </DetailSection>
  );
}
