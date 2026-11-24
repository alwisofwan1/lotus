"use client";

import { Play, SlidersHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ResourceMeta } from "@/components/resource/resource-kit";

import type { Automation, AutomationClient } from "../services/automation-api";
import { triggerOf } from "../services/automation-list";
import { metaOf, TriggerIcon } from "./InstalledTab";

/**
 * A channel's header: who it is (name, a state pill that says On or Off and flips it, one line on
 * what starts it) and what you can do now (run or review, and Settings).
 */
export function ChannelHeader({
  automation: a,
  client,
  settingsOpen,
  onOpenSettings,
  leading,
}: {
  /** Before the name: the sidebar toggle, when the sidebar is a drawer. */
  leading?: ReactNode;
  automation: Automation;
  client: AutomationClient;
  settingsOpen: boolean;
  onOpenSettings: () => void;
}) {
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const isPrompt = a.actionKind === "agent_prompt";

  const act = (work: Promise<unknown>, done?: string) => {
    setNotice(null);
    work.then(() => done && setNotice({ tone: "info", text: done })).catch((e: unknown) => setNotice({ tone: "error", text: String(e) }));
  };
  const primary = () =>
    isPrompt
      ? act(client.runScheduledNow(a.id), "Run started. Its result lands here.")
      : document.getElementById("au-review-url")?.focus();

  return (
    <header className="au-chead">
      {leading}
      <div className="au-chead-id">
        <div className="au-chead-titleline">
          <span className="au-chead-icon" aria-hidden>
            <TriggerIcon kind={triggerOf(a).kind} size={15} />
          </span>
          <h1 className="au-chead-title">{a.name}</h1>
          <button
            type="button"
            className="au-state-pill"
            data-on={a.enabled || undefined}
            aria-label={a.enabled ? `On. Turn off ${a.name}` : `Off. Turn on ${a.name}`}
            title={a.enabled ? "On: click to turn it off" : "Off: click to turn it on"}
            onClick={() => act(client.setEnabled(a.id, !a.enabled))}
          >
            <span className="au-state-dot" aria-hidden />
            {a.enabled ? "On" : "Off"}
          </button>
        </div>
        <div className="au-chead-meta">
          <ResourceMeta items={metaOf(a, 12)} />
        </div>
        {notice ? (
          <p className={notice.tone === "error" ? "au-error" : "au-note"} role={notice.tone === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
        ) : null}
      </div>
      <div className="au-chead-actions">
        <button type="button" className="rs-button" onClick={primary}>
          <Play size={13} aria-hidden />
          {isPrompt ? "Run now" : "Review a PR"}
        </button>
        <button
          type="button"
          className="rs-icon-button au-chead-settings"
          aria-label="Settings"
          aria-pressed={settingsOpen}
          title="Settings"
          onClick={onOpenSettings}
        >
          <SlidersHorizontal size={15} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </header>
  );
}
