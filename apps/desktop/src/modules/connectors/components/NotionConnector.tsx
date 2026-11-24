"use client";

import { Bot, BookOpen, KeyRound, ListTodo, ShieldCheck, Unplug } from "lucide-react";
import { useState, type FormEvent } from "react";

import { DetailHeader, DetailSection } from "@/components/resource/resource-kit";

import { describeNotion, type ConnectorsClient, type NotionStatus } from "../services/connectors-api";
import { SourceHealthDot } from "@/modules/tasks/components/SourceHealthBanner";
import type { HealthView } from "@/modules/tasks/services/source-health";

import { HealthPill } from "./connector-parts";

/**
 * Notion, connected with a token the person makes in Notion (plans/ticket-sources §2.2, mockup
 * `NOTION 01`). A personal access token acts as its owner, so no page has to be shared with a bot.
 * The token goes to the Keychain through Rust and never comes back here; this page only ever sees
 * who it acts as.
 *
 * What it does NOT promise, because Notion does not give it (research §8): a personal token has
 * one capability for all of REST, so it cannot be made read only at Notion — Lotus keeps a Read
 * only database read only itself — and Notion does not tell an app when a token expires.
 */
/** One Notion ticket source, as the Tasks board last saw it. */
export interface NotionSourceHealth {
  id: string;
  name: string;
  health: HealthView;
}

export function NotionConnector({
  client,
  status,
  sources = [],
}: {
  client: ConnectorsClient;
  status: NotionStatus | null;
  sources?: readonly NotionSourceHealth[];
}) {
  const { health, status: line } = describeNotion(status);

  return (
    <>
      <DetailHeader
        icon={<BookOpen size={16} strokeWidth={1.75} />}
        title="Notion"
        meta={
          <span className="cn-headmeta">
            <HealthPill health={health}>{line}</HealthPill>
          </span>
        }
      />

      {status?.state === "connected" ? <NotionConnection client={client} status={status} /> : <NotionSetup client={client} />}

      {sources.length > 0 ? (
        // The same line as the Tasks nav row, and the same banner as the list (SOURCES 06).
        <DetailSection title="Ticket sources" id="cn-notion-sources">
          <ul className="cn-sources">
            {sources.map((source) => (
              <li key={source.id} className="cn-source" aria-label={source.name}>
                <span className="cn-source-name">{source.name}</span>
                <span className="cn-source-line">
                  <SourceHealthDot health={source.health} />
                  {source.health.line}
                </span>
                {source.health.banner ? <p className="cn-source-banner">{source.health.banner}</p> : null}
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      <DetailSection title="What Lotus can do" id="cn-notion-does">
        <ul className="cn-points">
          <li>
            <ListTodo size={15} strokeWidth={1.75} aria-hidden />
            Use a Notion database as a ticket source in Tasks — add one or several, each with its own fields.
          </li>
          <li>
            <BookOpen size={15} strokeWidth={1.75} aria-hidden />
            Read tickets and their pages. Change them only in databases you set to Manage.
          </li>
          <li>
            <ShieldCheck size={15} strokeWidth={1.75} aria-hidden />
            The token acts as you and can write, so Lotus itself keeps every Read only database read only. It never
            writes comments or deletes permanently.
          </li>
        </ul>
      </DetailSection>

      <DetailSection title="Delegated agents" id="cn-notion-agents">
        <div className="au-callout" role="note">
          <Bot size={15} strokeWidth={1.75} aria-hidden />
          <p>
            <strong>Agents sign in to Notion themselves.</strong> They read Notion through Notion’s hosted MCP, signed in
            as you (<code>claude /mcp</code>). This token never reaches an agent.
          </p>
        </div>
      </DetailSection>
    </>
  );
}

function NotionSetup({ client }: { client: ConnectorsClient }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.notionConnect(token);
      setToken("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailSection title="Connect" id="cn-notion-connect">
      <form className="cn-setup" aria-label="Connect Notion" onSubmit={(e) => void connect(e)}>
        <ol className="cn-steps">
          <li>
            <span className="cn-step-text">
              In Notion’s developer portal, create a <strong>personal access token</strong>. It acts as you, so no page
              sharing is needed.
            </span>
          </li>
          <li>
            <span className="cn-step-text">
              Give it the <strong>Notion API</strong> capability, and pick how long it lasts — 1 year is the default.
            </span>
          </li>
          <li>
            <span className="cn-step-text">
              Paste it here. Lotus checks it with Notion and shows who it acts as. Notion does not tell apps when a token
              expires, so Lotus says so the day it stops working.
            </span>
            <label className="au-field">
              <span className="au-label">Token</span>
              <input
                className="au-input"
                type="password"
                autoComplete="off"
                placeholder="ntn_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          </li>
        </ol>
        {error ? (
          <p className="au-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="au-form-foot">
          <span className="au-note">
            <KeyRound size={13} aria-hidden /> Kept in the macOS Keychain. Never sent to an agent.
          </span>
          <span className="au-draft-actions">
            <button type="submit" className="rs-button rs-button--primary" disabled={busy || !token.trim()}>
              {busy ? "Checking…" : "Connect"}
            </button>
          </span>
        </div>
      </form>
    </DetailSection>
  );
}

function NotionConnection({ client, status }: { client: ConnectorsClient; status: NotionStatus }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnect = () => {
    setError(null);
    client
      .notionDisconnect()
      .then(() => setConfirm(false))
      .catch((e: unknown) => setError(String(e)));
  };
  const since = status.connectedAtMs
    ? new Date(status.connectedAtMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Unknown";
  const integration = status.kind === "integration";

  return (
    <DetailSection
      title="Connection"
      id="cn-notion-connection"
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
        <div className="au-callout au-callout--danger" role="alertdialog" aria-label="Disconnect Notion">
          <p>
            Disconnect Notion? Lotus deletes the token from the Keychain. The token itself keeps working until you revoke
            it in Notion. Your Notion pages stay as they are.
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
          <span className="au-fact-label">Acts as</span>
          <span className="au-fact-value">{status.name ?? "Unknown"}</span>
        </div>
        {integration ? (
          <div className="au-fact">
            <span className="au-fact-label">Workspace</span>
            <span className="au-fact-value">{status.workspace ?? "Unknown"}</span>
          </div>
        ) : (
          <div className="au-fact">
            <span className="au-fact-label">Email</span>
            <span className="au-fact-value">{status.email ?? "Unknown"}</span>
          </div>
        )}
        <div className="au-fact">
          <span className="au-fact-label">Token</span>
          <span className="au-fact-value">
            {integration ? "Integration token — pages must be shared with it" : "Personal access token"}
          </span>
        </div>
        <div className="au-fact">
          <span className="au-fact-label">Kept in</span>
          <span className="au-fact-value">
            <KeyRound size={13} aria-hidden /> macOS Keychain, never sent to an agent
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
