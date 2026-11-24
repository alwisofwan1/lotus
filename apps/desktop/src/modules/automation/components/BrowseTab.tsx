"use client";

import { CalendarClock, GitPullRequest, Hourglass, MessageCirclePlus, Newspaper, Search, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { SlackMark } from "@/components/icons/ServiceMarks";

import { TEMPLATES, type AutomationTemplate, type TemplateIcon } from "../services/templates";

const ICONS: Record<Exclude<TemplateIcon, "slack">, LucideIcon> = {
  brief: CalendarClock,
  digest: Newspaper,
  stale: Hourglass,
};

export function TemplateIconView({ icon, size = 16 }: { icon: TemplateIcon; size?: number }) {
  if (icon === "slack") return <SlackMark size={size - 2} />;
  const Icon = ICONS[icon];
  return <Icon size={size} strokeWidth={1.75} aria-hidden />;
}

type Filter = "all" | AutomationTemplate["trigger"];
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "slack", label: "From Slack" },
  { id: "schedule", label: "On a schedule" },
];

/** Templates that match a filter and a search over their title, description, when and output. */
export function findTemplates(templates: AutomationTemplate[], query: string, filter: Filter): AutomationTemplate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter((t) => {
    if (filter !== "all" && t.trigger !== filter) return false;
    const text = `${t.title} ${t.description} ${t.when} ${t.output}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/**
 * Browse: starting points. An example opens an agent with the request written out; building
 * one yourself opens the form. Cards, because each is a choice to compare, not a row to scan.
 *
 * With a `previewTarget` (the surface's right pane), a card opens a preview there first: what it
 * does, when, what it makes, and the exact request the agent gets. Use template starts it from
 * there. Without one, a card starts the template directly.
 */
export function BrowseTab({
  onUseTemplate,
  onNewForm,
  previewTarget,
  onOpenPreview,
}: {
  onUseTemplate: (template: AutomationTemplate) => void;
  onNewForm: (kind: "agent_prompt" | "pr_review") => void;
  /** The node the preview renders into; null while it mounts, undefined for no preview. */
  previewTarget?: HTMLElement | null;
  onOpenPreview?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const shown = findTemplates(TEMPLATES, query, filter);
  const picked = TEMPLATES.find((t) => t.id === pickedId) ?? null;
  const previews = previewTarget !== undefined;

  const pick = (t: AutomationTemplate) => {
    if (!previews) return onUseTemplate(t);
    setPickedId(t.id);
    onOpenPreview?.();
  };

  const preview = picked ? (
    <article className="au-preview" aria-label={`${picked.title} preview`}>
      <span className="au-template-icon">
        <TemplateIconView icon={picked.icon} />
      </span>
      <h2 className="au-preview-title">{picked.title}</h2>
      <p className="au-preview-text">{picked.description}</p>
      <dl className="au-preview-facts">
        <dt>When</dt>
        <dd>{picked.when}</dd>
        <dt>Output</dt>
        <dd>{picked.output}</dd>
      </dl>
      <h3 className="au-group-title">Example output</h3>
      <p className="au-preview-request au-preview-sample" aria-label="Example output">
        {picked.sample}
      </p>
      <h3 className="au-group-title">The agent may ask you</h3>
      <ul className="au-preview-asks" aria-label="Questions the agent may ask">
        {picked.asks.map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ul>
      <details className="au-preview-more">
        <summary>What the agent is told</summary>
        <p className="au-preview-request">{picked.request}</p>
      </details>
      <p className="au-hint">It skips what it can look up, shows you a summary, and saves the automation switched off.</p>
      <button type="button" className="rs-button rs-button--primary" onClick={() => onUseTemplate(picked)}>
        <MessageCirclePlus size={13} aria-hidden />
        Use template
      </button>
    </article>
  ) : (
    <div className="au-pane-empty">
      <strong>Pick an example</strong>
      <span>It opens here first, so you can read what it does before you start it.</span>
    </div>
  );

  return (
    <div className="au-browse">
      {previews && previewTarget ? createPortal(preview, previewTarget) : null}
      <div className="au-browse-tools">
        <label className="au-browse-search">
          <Search size={13} aria-hidden />
          <input
            type="search"
            aria-label="Search examples"
            placeholder="Search examples"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="au-browse-filters" role="group" aria-label="Filter examples">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="au-focus-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </span>
      </div>

      <section aria-labelledby="au-examples" className="au-inbox-group">
        <h2 id="au-examples" className="au-group-title">
          Start with an agent
        </h2>
        {shown.length === 0 ? (
          <p className="au-hint">No example matches. Try fewer words, or build it yourself below.</p>
        ) : (
          <div className="au-grid">
            {shown.map((t) => (
              <button
                key={t.id}
                type="button"
                className="au-template"
                aria-pressed={previews ? pickedId === t.id : undefined}
                onClick={() => pick(t)}
              >
                <span className="au-template-icon">
                  <TemplateIconView icon={t.icon} />
                </span>
                <span className="au-template-title">{t.title}</span>
                <span className="au-template-text">{t.description}</span>
                <span className="au-template-meta">
                  {t.when} · {t.output}
                </span>
                <span className="au-template-cta">
                  <MessageCirclePlus size={13} aria-hidden />
                  {previews ? "Preview" : "Use template"}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="au-build" className="au-inbox-group">
        <h2 id="au-build" className="au-group-title">
          Build it yourself
        </h2>
        <div className="au-grid">
          <button type="button" className="au-template" onClick={() => onNewForm("agent_prompt")}>
            <span className="au-template-icon">
              <CalendarClock size={16} strokeWidth={1.75} aria-hidden />
            </span>
            <span className="au-template-title">Scheduled prompt</span>
            <span className="au-template-text">Your own prompt on a schedule, with your review queue as data. Results go to Inbox and your DM.</span>
            <span className="au-template-cta">Open form</span>
          </button>
          <button type="button" className="au-template" onClick={() => onNewForm("pr_review")}>
            <span className="au-template-icon">
              <GitPullRequest size={16} strokeWidth={1.75} aria-hidden />
            </span>
            <span className="au-template-title">PR review</span>
            <span className="au-template-text">Drafts a review for PRs that request you. Run it on one PR, or let Slack start it.</span>
            <span className="au-template-cta">Open form</span>
          </button>
        </div>
      </section>
    </div>
  );
}
