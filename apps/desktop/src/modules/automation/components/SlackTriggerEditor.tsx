"use client";

import { useEffect, useState } from "react";

import type { Automation, AutomationClient, SlackChannel, SlackUserGroup } from "../services/automation-api";

/** Where a PR review listens in Slack: one channel, and optionally a team whose mention counts. */
export function SlackTriggerEditor({
  automation,
  client,
  onDone,
}: {
  automation: Automation;
  client: AutomationClient;
  onDone: () => void;
}) {
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [groups, setGroups] = useState<SlackUserGroup[]>([]);
  const [channel, setChannel] = useState(automation.slack?.channels[0] ?? "");
  const [team, setTeam] = useState(automation.slack?.team ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([client.slackChannels(), client.slackUsergroups().catch(() => [])])
      .then(([c, g]) => {
        if (!alive) return;
        setChannels(c);
        setGroups(g);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [client]);

  const save = async (toSave: string[]) => {
    setError(null);
    try {
      await client.setSlackTrigger(automation.id, toSave, toSave.length ? team || null : null);
      onDone();
    } catch (e) {
      setError(String(e));
    }
  };

  if (channels === null) {
    return error ? <p className="au-error">{error}</p> : <p className="au-note">Loading channels…</p>;
  }

  return (
    <div className="au-inline-form">
      <label className="au-field">
        <span className="au-label">Channel</span>
        <select className="au-input" value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">Choose a channel you are in</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.isPrivate ? "🔒 " : "#"}
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="au-field">
        <span className="au-label">Team mention</span>
        <select className="au-input" value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value="">Only mentions of me</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              @{g.handle}
            </option>
          ))}
        </select>
      </label>
      <p className="au-hint">
        A message there with a PR link that mentions you (or the team) starts a review. Your own :eyes: on any message
        there does too.
      </p>
      {error ? <p className="au-error">{error}</p> : null}
      <div className="au-draft-actions">
        {automation.slack ? (
          <button type="button" className="rs-button rs-button--ghost" onClick={() => void save([])}>
            Stop listening
          </button>
        ) : null}
        <button type="button" className="rs-button rs-button--ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="rs-button rs-button--primary" disabled={!channel} onClick={() => void save([channel])}>
          Save
        </button>
      </div>
    </div>
  );
}
