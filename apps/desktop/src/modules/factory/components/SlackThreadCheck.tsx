"use client";

import { useState } from "react";
import type { FactorySlackThread } from "@/lib/tauri/graph-run";

/** "Find Slack thread": where the PR's link was shared, as Slack search sees it now (CoS 12). */
export function SlackThreadCheck({
  runId,
  onFind,
  onError,
}: {
  runId: string;
  onFind: (runId: string) => Promise<FactorySlackThread | null>;
  onError: (message: string | null) => void;
}) {
  const [found, setFound] = useState<FactorySlackThread | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const find = async () => {
    setBusy(true);
    onError(null);
    try {
      setFound(await onFind(runId));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fa-chief-actions">
      <button type="button" className="rs-button" disabled={busy} title="Searches Slack for this PR's link, as you" onClick={() => void find()}>
        {busy ? "…" : "Find Slack thread"}
      </button>
      {found === undefined ? null : found ? (
        <a className="fa-chief-feedback-meta" href={found.permalink} target="_blank" rel="noreferrer">
          Found in #{found.channelName}
        </a>
      ) : (
        <span className="fa-chief-feedback-meta">No Slack thread shares this PR: no Slack message.</span>
      )}
    </div>
  );
}
