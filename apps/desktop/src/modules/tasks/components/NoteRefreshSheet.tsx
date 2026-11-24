"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { TasksModal } from "@/modules/tasks/components/TasksModal";
import type { PageMarkdown } from "@/modules/tasks/services/notion-source";
import {
  diffSummary,
  lineDiff,
  notionIsNewer,
  pullTime,
  pulledSectionBody,
  PULLED_SECTION,
} from "@/modules/tasks/services/notes-pull";

/**
 * "Refresh TKT-1008 from Notion" (mockup `NOTION 03`, old plan N11, N13): the page is read, made into
 * the note's `From Notion` section, and shown as a line diff against what the note holds now. Nothing
 * is written until "Update the vault note" — and then only that section and `notion_pulled:`.
 *
 * A page Notion could only partly express says so here and can still be applied: the note then holds
 * what could be read, and nothing is dropped without the person having seen that.
 *
 * Notion moves a page's edit time for a property change too (a status, an assignee), which leaves the
 * body as it was. Then there is nothing to write but the time — "Mark as up to date" — or the note
 * would say "Notion changed" forever.
 */
export interface PulledPage {
  page: PageMarkdown;
  /** The page's `last_edited_time`, read before its body: what the note is stamped with. */
  editedAt: string;
}

export function NoteRefreshSheet({
  noteKey,
  keptHeadings,
  current,
  pulledAt,
  load,
  onApply,
  blockedReason,
  onClose,
}: {
  noteKey: string;
  /** The note's other sections, named so the promise "they stay as they are" is concrete. */
  keptHeadings: readonly string[];
  /** The note's `From Notion` body as it is now, or "" before the first pull. */
  current: string;
  /** The note's `notion_pulled:`, or null before the first pull. */
  pulledAt: string | null;
  load: () => Promise<PulledPage>;
  /** Writes the section — or, with `body` null, only the pulled time. Resolves to why not, or null. */
  onApply: (body: string | null, editedAt: string) => Promise<string | null>;
  /** Set while the note cannot take a pull (unsaved typing in it). */
  blockedReason?: string | null;
  onClose: () => void;
}) {
  const headingId = useId();
  const [read, setRead] = useState<PulledPage | null>(null);
  const page = read?.page ?? null;
  const editedAt = read?.editedAt ?? null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((pulled) => !cancelled && setRead(pulled))
      .catch((cause) => !cancelled && setError(`The page could not be read: ${String(cause)}`));
    return () => {
      cancelled = true;
    };
    // Read once per open sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const next = useMemo(() => (page ? pulledSectionBody(page.markdown) : null), [page]);
  const diff = useMemo(() => (next === null ? [] : lineDiff(current, next)), [current, next]);
  const unchanged = next !== null && next === current.trim();
  const partial = Boolean(page && (page.truncated || page.unknownBlockIds.length > 0));
  const kept = keptHeadings.filter((heading) => heading !== PULLED_SECTION);

  // Nothing to write in the body, but Notion has moved on (a property edit): the time is still worth keeping.
  const stampOnly = unchanged && editedAt !== null && notionIsNewer(editedAt, pulledAt);

  const apply = async () => {
    if (next === null || editedAt === null || busy) return;
    setBusy(true);
    const refused = await onApply(stampOnly ? null : next, editedAt);
    setBusy(false);
    if (refused) setError(refused);
    else onClose();
  };

  return (
    <TasksModal labelledBy={headingId} onClose={onClose} size="lg" className="tk-pull">
      <div className="tk-pull-head">
        <h2 className="tk-add-source-title" id={headingId}>
          Refresh {noteKey} from Notion
        </h2>
        <p className="tk-pull-sub">
          Only the {PULLED_SECTION} section changes.
          {kept.length > 0 ? ` ${joinNames(kept)} stay exactly as they are.` : ""}
        </p>
      </div>

      {error ? <p className="tk-error" role="alert">{error}</p> : null}
      {!page && !error ? <p className="tk-add-notion-note tk-pull-state">Reading the page from Notion…</p> : null}
      {partial ? (
        <p className="tk-callout tk-pull-partial" role="note">
          Part of this page cannot be read by an app
          {page?.truncated ? " — it is longer than Notion hands out at once" : ""}. The note gets what could be read.
        </p>
      ) : null}

      {next !== null ? (
        unchanged ? (
          <p className="tk-add-notion-note tk-pull-state">
            {stampOnly
              ? "The page body is the same as the note’s — only its properties changed in Notion."
              : "The note already has this version."}
          </p>
        ) : (
          <ol className="tk-pull-diff" aria-label="Changes to the From Notion section">
            {diff.map((line, index) => (
              <li key={index} className="tk-pull-line" data-kind={line.kind}>
                <span className="tk-pull-mark" aria-label={line.kind === "same" ? undefined : line.kind}>
                  {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
                </span>
                <span className="tk-pull-text">{line.text || " "}</span>
              </li>
            ))}
          </ol>
        )
      ) : null}

      <div className="tk-add-notion-foot tk-pull-foot">
        <span className="tk-add-notion-note">
          {blockedReason ??
            [editedAt ? `Notion edited ${pullTime(editedAt)}` : null, next !== null && !unchanged ? diffSummary(diff) : null]
              .filter(Boolean)
              .join("  ·  ")}
        </span>
        <button type="button" className="tk-button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="tk-button tk-button--primary"
          disabled={next === null || (unchanged && !stampOnly) || busy || Boolean(blockedReason)}
          onClick={() => void apply()}
        >
          {busy ? "Updating…" : stampOnly ? "Mark as up to date" : "Update the vault note"}
        </button>
      </div>
    </TasksModal>
  );
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
