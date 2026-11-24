"use client";

import { BookOpen, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

import {
  ResourceBar,
  ResourceDescription,
  ResourceList,
  ResourcePage,
  ResourceRow,
  SkeletonRows,
  type Crumb,
} from "@/components/resource/resource-kit";
import { GitHubMark, GoogleMark, SlackMark } from "@/components/icons/ServiceMarks";

import "@/styles/automation.css";
import "@/styles/connectors.css";

import {
  summarize,
  type AutomationUse,
  type ConnectorId,
  type ConnectorsClient,
  type GhAccount,
  type GoogleStatus,
  type NotionStatus,
  type SlackStatus,
  type Subscribe,
} from "../services/connectors-api";
import { HealthPill, OpenAutomationContext } from "./connector-parts";
import { GitHubConnector, type GitHubSourceHealth } from "./GitHubConnector";
import { GoogleConnector } from "./GoogleConnector";
import { NotionConnector, type NotionSourceHealth } from "./NotionConnector";
import { SlackConnector } from "./SlackConnector";

/**
 * Connectors: the outside accounts Lotus acts through — one row each, one page each. A surface
 * of its own (not a section of Automations) because a connection outlives any one automation,
 * several automations share it, and the next connector should be one more row, not a redesign.
 */

type Snapshot = {
  loaded: boolean;
  slack: SlackStatus | null;
  accounts: GhAccount[] | null;
  google: GoogleStatus | null;
  notion: NotionStatus | null;
  automations: AutomationUse[];
  error: string | null;
};

function useConnectors(client: ConnectorsClient, subscribe: Subscribe): Snapshot {
  const [snap, setSnap] = useState<Snapshot>({
    loaded: false,
    slack: null,
    accounts: null,
    google: null,
    notion: null,
    automations: [],
    error: null,
  });
  useEffect(() => {
    let alive = true;
    const load = () =>
      void Promise.all([
        client.slackStatus().catch(() => null),
        client.ghAccounts().catch(() => [] as GhAccount[]),
        client.googleStatus().catch(() => null),
        client.notionStatus().catch(() => null),
        client.automations().catch(() => [] as AutomationUse[]),
      ]).then(([slack, accounts, google, notion, automations]) => {
        if (alive) setSnap({ loaded: true, slack, accounts, google, notion, automations, error: null });
      });
    load();
    const off = subscribe(load);
    return () => {
      alive = false;
      off();
    };
  }, [client, subscribe]);
  return snap;
}

const MARK: Record<ConnectorId, ReactNode> = {
  slack: <SlackMark size={16} />,
  github: <GitHubMark size={16} />,
  google: <GoogleMark size={16} />,
  notion: <BookOpen size={16} strokeWidth={1.75} aria-hidden />,
};

const BLURB: Record<ConnectorId, string> = {
  slack: "Review requests from mentions and :eyes:, results to your DM.",
  github: "Pull requests, diffs and reviews, through the gh CLI.",
  google: "Report rows to a Sheet and files to Drive. Only files Lotus makes or you pick.",
  notion: "Notion databases as ticket sources in Tasks. Changes only where you allow them.",
};

export interface ConnectorsSurfaceProps {
  client: ConnectorsClient;
  subscribe: Subscribe;
  onClose: () => void;
  /** Opens a connector's page directly (e.g. from an automation that needs Slack). */
  initial?: ConnectorId;
  /** The Notion ticket sources and their health, as the Tasks board has them. */
  notionSources?: readonly NotionSourceHealth[];
  /** The GitHub ticket sources and their health, the same way. */
  githubSources?: readonly GitHubSourceHealth[];
  /** Opens one automation in Automations, from a connector's Used by list. */
  onOpenAutomation?: (id: string) => void;
}

export function ConnectorsSurface({
  client,
  subscribe,
  onClose,
  initial,
  notionSources,
  githubSources,
  onOpenAutomation,
}: ConnectorsSurfaceProps) {
  const snap = useConnectors(client, subscribe);
  const [open, setOpen] = useState<ConnectorId | null>(initial ?? null);
  const connectors = summarize(snap.slack, snap.accounts, snap.automations, snap.google, snap.notion);
  const current = connectors.find((c) => c.id === open);

  const crumbs: Crumb[] = [{ label: "Connectors", onClick: () => setOpen(null) }];
  if (current) crumbs.push({ label: current.name });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || !open) return;
    if ((event.target as HTMLElement).closest("input, textarea, select, details[open]")) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(null);
  };

  return (
    <div className="ws-body au-body">
      <div className="ws-column au-column rs-surface" onKeyDown={onKeyDown}>
        <ResourceBar
          crumbs={crumbs}
          actions={
            <button type="button" className="rs-icon-button" onClick={onClose} aria-label="Close connectors" title="Close">
              <X size={15} strokeWidth={1.75} aria-hidden />
            </button>
          }
        />
        {current ? (
          <ResourcePage width="detail">
            <OpenAutomationContext.Provider value={onOpenAutomation ?? null}>
              <div className="cn-page">
                {current.id === "slack" ? (
                  <SlackConnector client={client} status={snap.slack} usedBy={current.usedBy} />
                ) : current.id === "google" ? (
                  <GoogleConnector client={client} status={snap.google} usedBy={current.usedBy} />
                ) : current.id === "notion" ? (
                  <NotionConnector client={client} status={snap.notion} sources={notionSources} />
                ) : (
                  <GitHubConnector accounts={snap.accounts} usedBy={current.usedBy} sources={githubSources} />
                )}
              </div>
            </OpenAutomationContext.Provider>
          </ResourcePage>
        ) : (
          <ResourcePage>
            <ResourceDescription>
              The accounts automations act through. Tokens stay in the macOS Keychain or with the tool that owns them, and
              never reach this window.
            </ResourceDescription>
            {!snap.loaded ? (
              <SkeletonRows count={4} label="Loading connectors" />
            ) : (
              <ResourceList label="Connectors">
                {connectors.map((c) => (
                  <ResourceRow
                    key={c.id}
                    label={c.name}
                    leading={MARK[c.id]}
                    title={c.name}
                    meta={
                      <span className="cn-rowmeta">
                        {BLURB[c.id]}
                        {c.usedBy.length ? ` · Used by ${c.usedBy.length} automation${c.usedBy.length === 1 ? "" : "s"}` : ""}
                      </span>
                    }
                    trailing={<HealthPill health={c.health}>{c.status}</HealthPill>}
                    onOpen={() => setOpen(c.id)}
                  />
                ))}
              </ResourceList>
            )}
          </ResourcePage>
        )}
      </div>
    </div>
  );
}
