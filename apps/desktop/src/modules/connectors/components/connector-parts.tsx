"use client";

import { CalendarClock, GitPullRequest, type LucideIcon } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { DetailSection, EmptyState, Pill, ResourceList, ResourceRow, ResourceTabs, type Tab } from "@/components/resource/resource-kit";

import type { AutomationUse, ConnectorHealth } from "../services/connectors-api";

const TONE: Record<ConnectorHealth, "ok" | "danger" | "warn" | "neutral"> = {
  connected: "ok",
  attention: "danger",
  busy: "warn",
  off: "neutral",
};

/** A connector's state, in words and colour both. */
export function HealthPill({ health, children }: { health: ConnectorHealth; children: ReactNode }) {
  return (
    <Pill tone={TONE[health]}>
      <span className="cn-dot" data-health={health} aria-hidden />
      {children}
    </Pill>
  );
}

/**
 * Opens one automation in Automations, from a Used by row. Provided by the surface so every
 * connector's page gets it without passing it down; absent, the rows are plain.
 */
export const OpenAutomationContext = createContext<((id: string) => void) | null>(null);

export function UsedBy({ automations, empty }: { automations: AutomationUse[]; empty: string }) {
  const openAutomation = useContext(OpenAutomationContext);
  return (
    <DetailSection title="Used by" id="cn-used-by">
      {automations.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ResourceList label="Automations using this connector">
          {automations.map((a) => (
            <ResourceRow
              key={a.id}
              label={a.name}
              leading={
                <span className="cn-row-icon">
                  {a.actionKind === "pr_review" ? (
                    <GitPullRequest size={14} strokeWidth={1.75} aria-hidden />
                  ) : (
                    <CalendarClock size={14} strokeWidth={1.75} aria-hidden />
                  )}
                </span>
              }
              title={a.name}
              muted={!a.enabled}
              meta={a.actionKind === "pr_review" ? "PR review" : "Scheduled prompt"}
              trailing={
                <Pill tone={a.enabled ? "ok" : "neutral"}>
                  <span className="cn-dot" data-health={a.enabled ? "connected" : "off"} aria-hidden />
                  {a.enabled ? "On" : "Off"}
                </Pill>
              }
              onOpen={openAutomation ? () => openAutomation(a.id) : undefined}
            />
          ))}
        </ResourceList>
      )}
    </DetailSection>
  );
}

/** The few facts a connector page leads with, side by side: is it working, and what leans on it. */
export function StatStrip({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="cn-stats" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: ReactNode;
  /** Colours the dot before the value; none draws no dot. */
  tone?: "ok" | "warn" | "danger" | "off";
  children?: ReactNode;
}) {
  return (
    <div className="cn-stat">
      <span className="cn-stat-label">{label}</span>
      <span className="cn-stat-value">
        {tone ? <span className="cn-stat-dot" data-tone={tone} aria-hidden /> : null}
        {value}
      </span>
      {children ? <span className="cn-stat-sub">{children}</span> : null}
    </div>
  );
}

export type HowItem = { icon: LucideIcon; title: string; text: string };

/** What a connector does, in a few short cards; the full fine print folds away under them. */
export function HowItWorks({ items, details, id }: { items: HowItem[]; details?: ReactNode; id: string }) {
  return (
    <DetailSection title="How it works" id={id}>
      <ul className="cn-how">
        {items.map(({ icon: Icon, title, text }) => (
          <li key={title} className="cn-how-card">
            <span className="cn-how-icon" aria-hidden>
              <Icon size={15} strokeWidth={1.75} />
            </span>
            <span className="cn-how-text">
              <span className="cn-how-title">{title}</span>
              <span className="cn-how-line">{text}</span>
            </span>
          </li>
        ))}
      </ul>
      {details ? (
        <details className="cn-fine">
          <summary>Every detail</summary>
          {details}
        </details>
      ) : null}
    </DetailSection>
  );
}

/**
 * Tabs drawn as an underlined row, with their panels. Every panel stays mounted and only the
 * chosen one shows, so an unsaved edit in one tab survives a look at another.
 */
export function ConnectorTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  panels,
}: {
  tabs: Tab<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  panels: Record<T, ReactNode>;
}) {
  return (
    <>
      <div className="cn-tabs">
        <ResourceTabs tabs={tabs} value={value} onChange={onChange} label={label} />
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} className="cn-panel" role="tabpanel" aria-label={tab.label} hidden={tab.id !== value}>
          {panels[tab.id]}
        </div>
      ))}
    </>
  );
}
