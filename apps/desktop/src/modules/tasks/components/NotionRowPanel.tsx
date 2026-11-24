"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink, Trash2 } from "lucide-react";
import { openExternalLink } from "@/lib/tauri-api";
import { TaskDetailBar } from "@/modules/tasks/components/TaskDetailBar";
import { TaskStatusGlyph } from "@/modules/tasks/components/TaskGlyphs";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";
import { TaskMarkdown } from "@/modules/tasks/components/TaskMarkdown";
import { DelegateMenu } from "@/modules/tasks/components/DelegateMenu";
import { EditableTitle } from "@/modules/tasks/components/EditableTitle";
import { NotionSubTickets, type NotionSubTicketsProps } from "@/modules/tasks/components/NotionSubTickets";
import { NotionMultiMenu } from "@/modules/tasks/components/NotionMultiMenu";
import { NotionFactoryRun, type NotionTicketFactory } from "@/modules/tasks/components/NotionFactoryRun";
import { TaskPropertyMenu } from "@/modules/tasks/components/TaskPropertyMenu";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import { cleanNotionMarkdown } from "@/modules/tasks/services/notion-markdown";
import type {
  NotionRow,
  NotionSourceClient,
  PageMarkdown,
  BodyOutcome,
  TicketChange,
  WriteOutcome,
} from "@/modules/tasks/services/notion-source";
import type { ListPosition } from "@/modules/tasks/services/task-detail";
import { statusLabel, type StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";
import type { BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";

/**
 * A Notion ticket (mockup `SOURCES 04`): its page body, read from Notion when it is opened and never
 * kept with the list (PLAN S30), beside the properties the list already read.
 *
 * Read only here: the body is Notion's markdown made plain (`notion-markdown.ts`) and drawn by the
 * tracker's reader, which renders no HTML. A page Notion could only partly express says so, with
 * the way to read the rest in Notion.
 */
/** A Lotus task this ticket has become. */
export interface NotionTicketWork {
  id: string;
  key: string | null;
  status: string;
  vocabulary: StatusVocabulary;
  projectName: string;
}

/**
 * What a Manage database lets this page change (PLAN S41). Absent means Read only: the fields are
 * shown, with nothing to change them.
 */
export interface NotionEditing {
  /** People seen on this board — a personal token cannot list the workspace's users. */
  people: readonly { id: string; name: string }[];
  /** Labels seen on this board. */
  labels: readonly string[];
  /** One field, as the person saw the ticket. Rust checks Notion still has it that way first. */
  write: (change: TicketChange, seen: NotionRow) => Promise<WriteOutcome>;
  /** Asks to move this ticket to Notion's trash — the caller confirms first (S45). */
  onTrash?: () => void;
  /** Saves the page body: `seen` is Notion's markdown as opened, `markdown` the edit (S43). */
  writeBody?: (seen: string, markdown: string) => Promise<BodyOutcome>;
}

/**
 * A note about this ticket kept elsewhere, matched by key (PLAN S37) — the "Notes" section. The
 * panel does not know where notes live: the caller brings the note's name, the mark of the place it
 * lives in, and how to open it.
 */
export interface NotionTicketNote {
  /** What the link says — where the note is, then its file: `orbit-vault / TKT-1008.md`. */
  name: string;
  mark: ReactNode;
  /** One line under it, in the words of the place the note lives in. */
  hint?: string;
  onOpen: () => void;
}

export interface NotionDelegation {
  presets: readonly DelegationPreset[];
  ready: boolean;
  busy: boolean;
  /** Why the last Delegate failed. Shown on the panel: the list, where it was shown before, is covered by it. */
  error?: string | null;
  /** The Lotus workspaces a task made from this ticket could live in. */
  targets: readonly { id: string; name: string }[];
  targetId: string;
  onTargetChange: (id: string) => void;
  /**
   * `body` is the page exactly as Notion sent it, so the task keeps a copy of what was delegated.
   * Raw, not the drawn version: the agent reads plain text, where the reader's markdown fixes
   * (hard-break backslashes, escaped markers, no-break spaces) would only be noise.
   */
  onDelegate: (preset: DelegationPreset, body: string | null) => void;
  onNewPreset: () => void;
  onEditPreset: (preset: DelegationPreset) => void;
}

export function NotionRowPanel({
  row: listed,
  client,
  editing,
  subTickets,
  delegation,
  factory,
  workedAs = [],
  note,
  onOpenTask,
  projectName,
  syncLine,
  vocabulary,
  position,
  onBack,
  onStep,
  barTrailing,
}: {
  row: NotionRow;
  client: Pick<NotionSourceClient, "pageMarkdown">;
  editing?: NotionEditing;
  /** This ticket's sub-tickets and, on a sub-ticket, its main ticket. */
  subTickets?: NotionSubTicketsProps;
  /** Absent where this surface cannot delegate. */
  delegation?: NotionDelegation;
  /** Building the ticket as a Factory Run (#168). Absent with no GitHub source, or with no key. */
  factory?: NotionTicketFactory;
  /** The Lotus tasks this ticket has become, matched by page id. */
  workedAs?: readonly NotionTicketWork[];
  /** The note matched with this ticket by key. Absent: no note, or matching is off. */
  note?: NotionTicketNote;
  onOpenTask?: (taskId: string) => void;
  projectName: string;
  /** The source's own line — "Notion · synced 09:30" — so the page says how fresh its facts are. */
  syncLine?: string;
  vocabulary: StatusVocabulary;
  position: ListPosition | null;
  onBack: () => void;
  onStep?: (taskId: string) => void;
  barTrailing?: ReactNode;
}) {
  const { row, busy, notice, change } = useTicketWrites(listed, editing);
  const edited = Date.parse(row.lastEditedTime);
  const { body, replace: replaceBody } = usePageBody(client, row.pageId, row.lastEditedTime);
  const cleaned = useMemo(() => (body.page ? cleanNotionMarkdown(body.page.markdown) : null), [body.page]);
  /*
    A bookmark, an embed or a link preview comes back inside the markdown as `<unknown …/>` without
    `truncated` or an unknown block id (task "Ticket Sources 16"); the cleaner counts those — outside
    code only — so they make the page partial too, and Rust refuses its body write the same way.
  */
  const partial = Boolean(
    body.page && (body.page.truncated || body.page.unknownBlockIds.length > 0 || (cleaned?.unknownBlocks ?? 0) > 0),
  );
  const openInNotion = row.url ? () => void openExternalLink(row.url!) : undefined;
  const bodyEdit = useBodyEditing(body.page?.markdown ?? null, editing?.writeBody, replaceBody);
  // Editable only when every block of it could be shown, and there is something to search in (S44).
  const bodyEditable = Boolean(editing?.writeBody && body.state === "read" && !partial && body.page?.markdown.trim());

  return (
    <div className="tk-detail">
      <TaskDetailBar
        mark={<TicketSourceMark kind="notion" size={13} />}
        projectName={projectName}
        taskKey={row.key}
        position={position}
        onBack={onBack}
        onStep={onStep}
        trailing={barTrailing}
      />

      <div className="tk-detail-scroll">
        <div className="tk-detail-page">
          <article className="tk-detail-main">
            {editing ? (
              // Keyed on the saved title, so Notion's answer (or a conflict's fresh copy) re-seeds it.
              <EditableTitle
                key={row.title}
                title={row.title}
                label="Title"
                onCommit={(title) => {
                  if (busy) return false;
                  change({ field: "title", value: title });
                }}
              />
            ) : (
              <h2 className="tk-detail-title">{row.title || "Untitled"}</h2>
            )}
            {delegation?.error ? (
              <p className="tk-callout tk-callout--blocked tk-notion-notice" role="alert">
                {delegation.error}
              </p>
            ) : null}
            {notice ? (
              <p className="tk-callout tk-callout--blocked tk-notion-notice" role="alert">
                {notice}
              </p>
            ) : null}
            <p className="tk-notion-body-note">
              Page body from Notion · {bodyEditable ? "editable here" : "read only here"}
              {openInNotion ? (
                <>
                  {" · "}
                  <button type="button" className="tk-props-link" onClick={openInNotion}>
                    Edit in Notion
                    <ExternalLink size={11} strokeWidth={2} aria-hidden />
                  </button>
                </>
              ) : null}
            </p>

            {/* Dev builds only: the page exactly as Notion sent it, to compare with how it is drawn. */}
            {process.env.NODE_ENV === "development" && body.page ? (
              <button
                type="button"
                className="tk-button"
                onClick={() => void navigator.clipboard?.writeText(body.page!.markdown)}
                title="Copies the markdown Notion returned for this page, before it is made plain"
              >
                Copy Notion markdown (dev)
              </button>
            ) : null}

            {body.state === "reading" ? <p className="tk-empty tk-notion-body-state">Reading the page…</p> : null}
            {body.state === "failed" ? (
              <p className="tk-error" role="alert">
                The page could not be read: {body.error}
              </p>
            ) : null}
            {partial ? (
              <p className="tk-callout tk-notion-partial" role="note">
                Part of this page cannot be shown here
                {body.page?.truncated ? " — it is longer than Notion lets an app read at once" : ""}.
                {openInNotion ? (
                  <>
                    {" "}
                    <button type="button" className="tk-props-link" onClick={openInNotion}>
                      Read it in Notion
                      <ExternalLink size={11} strokeWidth={2} aria-hidden />
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
            {editing?.writeBody && partial ? (
              <p className="tk-notion-body-note">
                This page has blocks Lotus cannot show, so its body is changed in Notion — Edit in Notion.
              </p>
            ) : null}

            {bodyEditable && bodyEdit.draft === null ? (
              <button type="button" className="tk-button tk-notion-body-edit" onClick={bodyEdit.start}>
                Edit body
              </button>
            ) : null}

            {bodyEdit.draft !== null ? (
              <section className="tk-detail-section tk-notion-body-editor">
                {bodyEdit.notice ? (
                  <div className="tk-callout tk-callout--blocked tk-notion-body-notice" role="alert">
                    <span>{bodyEdit.notice}</span>
                    {bodyEdit.fresh !== null ? (
                      <button type="button" className="tk-button" onClick={bodyEdit.loadFresh}>
                        Load Notion’s version
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <textarea
                  className="tk-notion-body-textarea"
                  aria-label="Page body (Notion markdown)"
                  value={bodyEdit.draft}
                  disabled={bodyEdit.busy}
                  spellCheck
                  onChange={(event) => bodyEdit.setDraft(event.target.value)}
                  rows={Math.min(40, Math.max(8, bodyEdit.draft.split("\n").length + 2))}
                />
                <p className="tk-notion-body-hint">
                  Notion’s own markdown. Only the lines you change are sent; tags like &lt;callout&gt; are Notion blocks.
                </p>
                <div className="tk-notion-body-actions">
                  <button type="button" className="tk-button" onClick={bodyEdit.cancel} disabled={bodyEdit.busy}>
                    Cancel
                  </button>
                  <button type="button" className="tk-button tk-button--primary" onClick={bodyEdit.save} disabled={bodyEdit.busy}>
                    {bodyEdit.busy ? "Saving…" : "Save body"}
                  </button>
                </div>
              </section>
            ) : cleaned ? (
              cleaned.markdown ? (
                <section className="tk-detail-section">
                  <TaskMarkdown>{cleaned.markdown}</TaskMarkdown>
                </section>
              ) : (
                <p className="tk-empty tk-notion-body-state">This page has no body.</p>
              )
            ) : null}
            {subTickets ? (
              <NotionSubTickets
                // A draft belongs to the ticket it was typed on: another ticket starts empty.
                key={row.pageId}
                rows={subTickets.rows}
                add={subTickets.add}
                onOpen={subTickets.onOpen}
                vocabulary={vocabulary}
                mainKey={row.key}
              />
            ) : null}
          </article>

          <aside className="tk-props" aria-label="Properties">
            <h3 className="tk-props-h">Status</h3>
            {editing ? (
              <div role="group" aria-label="Status" className="tk-notion-status" data-busy={busy || undefined}>
                <TaskPropertyMenu
                  kind="status"
                  vocabulary={vocabulary}
                  value={row.status ?? ""}
                  showLabel
                  disabled={busy}
                  onChange={(next) => change({ field: "status", value: next })}
                />
              </div>
            ) : (
              <p className="tk-props-value">
                {row.status ? (
                  <>
                    <TaskStatusGlyph status={row.status as BridgeTaskStatus} vocabulary={vocabulary} decorative />
                    {statusLabel(vocabulary, row.status)}
                  </>
                ) : (
                  "No status"
                )}
              </p>
            )}

            {editing ? (
              <>
                <h3 className="tk-props-h">Assignee</h3>
                <NotionMultiMenu
                  label="Assignee"
                  noun="person"
                  kind="people"
                  choices={mergePeople(editing.people, row)}
                  chosen={row.assigneeIds}
                  disabled={busy}
                  onChange={(ids) => change({ field: "assignees", value: ids })}
                />
                <h3 className="tk-props-h">Labels</h3>
                <NotionMultiMenu
                  label="Labels"
                  noun="label"
                  kind="labels"
                  choices={[...new Set([...editing.labels, ...row.labels])].map((name) => ({ id: name, name }))}
                  chosen={row.labels}
                  disabled={busy}
                  onChange={(names) => change({ field: "labels", value: names })}
                />
              </>
            ) : (
              <>
                {row.assignees.length > 0 ? (
                  <>
                    <h3 className="tk-props-h">Assignee</h3>
                    <p className="tk-props-value">{row.assignees.join(", ")}</p>
                  </>
                ) : null}

                {row.labels.length > 0 ? (
                  <>
                    <h3 className="tk-props-h">Labels</h3>
                    <p className="tk-props-value">{row.labels.join(", ")}</p>
                  </>
                ) : null}
              </>
            )}

            {subTickets?.parent ? (
              <>
                <h3 className="tk-props-h">Parent</h3>
                <button type="button" className="tk-props-link" onClick={() => subTickets.onOpen(subTickets.parent!.pageId)}>
                  <span className="tk-subticket-key">{subTickets.parent.key ?? "—"}</span>
                  <span className="tk-subticket-title">{subTickets.parent.title || "Untitled"}</span>
                </button>
              </>
            ) : null}

            {delegation ? (
              <>
                <h3 className="tk-props-h">Agent</h3>
                {/* Shown, not assumed: the ticket belongs to no workspace. */}
                {delegation.targets.length > 1 ? (
                  <label className="tk-select-chip tk-select-chip--block">
                    <span className="tk-select-chip-value">
                      in {delegation.targets.find((target) => target.id === delegation.targetId)?.name ?? "…"}
                    </span>
                    <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
                    <select
                      value={delegation.targetId}
                      aria-label="Workspace for this work"
                      onChange={(event) => delegation.onTargetChange(event.target.value)}
                    >
                      {delegation.targets.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : delegation.targets[0] ? (
                  <p className="tk-props-note">in {delegation.targets[0].name}</p>
                ) : null}
                <DelegateMenu
                  presets={delegation.presets}
                  ready={delegation.ready && delegation.targets.length > 0}
                  busy={delegation.busy}
                  onDelegate={(preset) => delegation.onDelegate(preset, body.page?.markdown ?? null)}
                  onNewPreset={delegation.onNewPreset}
                  onEditPreset={delegation.onEditPreset}
                />
                <p className="tk-props-note">The agent reads this page in Notion and cannot write to it.</p>
              </>
            ) : null}

            {factory && row.key && row.url ? (
              <NotionFactoryRun
                factory={factory}
                ticket={{ key: row.key, title: row.title, pageId: row.pageId, url: row.url }}
                presets={delegation?.presets ?? []}
              />
            ) : null}

            {note ? (
              <>
                <h3 className="tk-props-h">Notes</h3>
                <button type="button" className="tk-props-link tk-notion-note" onClick={note.onOpen} title={`Open ${note.name}`}>
                  {note.mark}
                  {note.name}
                </button>
                {note.hint ? <p className="tk-props-note">{note.hint}</p> : null}
              </>
            ) : null}

            {workedAs.length > 0 ? (
              <>
                <h3 className="tk-props-h">Work</h3>
                <ul className="tk-props-work">
                  {workedAs.map((work) => (
                    <li key={work.id}>
                      <button
                        type="button"
                        className="tk-props-link"
                        onClick={() => onOpenTask?.(work.id)}
                        title={`${statusLabel(work.vocabulary, work.status)} · ${work.projectName}`}
                      >
                        <TaskStatusGlyph status={work.status as BridgeTaskStatus} vocabulary={work.vocabulary} decorative />
                        {work.key ?? "Task"}
                        <span className="tk-props-work-where">{work.projectName}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <h3 className="tk-props-h">Source</h3>
            {openInNotion ? (
              <button type="button" className="tk-props-link" onClick={openInNotion} title={row.url ?? undefined}>
                Open in Notion
                <ExternalLink size={11} strokeWidth={2} aria-hidden />
              </button>
            ) : null}
            {syncLine ? <p className="tk-props-value tk-notion-sync">{syncLine}</p> : null}

            {editing?.onTrash ? (
              <button type="button" className="tk-props-link tk-props-trash" onClick={editing.onTrash} disabled={busy}>
                <Trash2 size={13} strokeWidth={1.75} aria-hidden />
                Move to trash
              </button>
            ) : null}

            <p className="tk-props-foot">
              {[
                Number.isNaN(edited)
                  ? null
                  : `Edited in Notion ${new Date(edited).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
                editing ? "fields change in Notion when you change them here" : "read only here",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}

/**
 * The ticket as this page shows it, and the one way it changes: a write, answered by Notion.
 * Only a `saved` answer changes the fields to the new value; a conflict or a 5xx that did not land
 * shows Notion's version instead, and a refusal leaves them as they were (PLAN S32–S34).
 */
function useTicketWrites(listed: NotionRow, editing: NotionEditing | undefined) {
  const [state, setState] = useState({ page: listed.pageId, row: listed, listed, busy: false, notice: null as string | null });
  // Another ticket starts clean. A newer copy of THIS ticket (a sync, a write's answer landing in the
  // list) replaces the fields — but not while a write is out, and it keeps the notice on screen.
  let current = state;
  if (state.page !== listed.pageId) {
    current = { page: listed.pageId, row: listed, listed, busy: false, notice: null };
  } else if (state.listed !== listed && !state.busy) {
    current = { ...state, row: listed, listed };
  }
  if (current !== state) setState(current);
  // Read synchronously, so a second change in the same moment is refused before a render catches up.
  const busy = useRef(false);
  // The copy the list holds now. A write's answer is newer than any copy that arrived while it was
  // out, so that copy counts as seen when the answer lands.
  const latest = useRef(listed);
  useEffect(() => {
    latest.current = listed;
  });

  const change = (next: TicketChange) => {
    if (!editing || busy.current) return;
    busy.current = true;
    const seen = current.row;
    const page = current.page;
    setState({ ...current, busy: true, notice: null });
    void editing
      .write(next, seen)
      .then((outcome): [NotionRow, string | null] => {
        switch (outcome.outcome) {
          case "saved":
            return [outcome.row, null];
          case "conflict":
            return [outcome.fresh, "This was changed in Notion since you opened it. This is the version there now — make your change again if you still want it."];
          case "not_saved":
            return [outcome.fresh, `Notion did not save the change. ${outcome.message}`];
          case "unknown":
            return [seen, outcome.message];
          case "refused":
            return [seen, `Write refused. ${outcome.message}`];
        }
      })
      .catch((cause): [NotionRow, string | null] => [seen, `Write refused. ${String(cause)}`])
      .then(([row, notice]) => {
        busy.current = false;
        setState((now) => (now.page === page ? { ...now, row, listed: latest.current, busy: false, notice } : now));
      });
  };
  return { row: current.row, busy: current.busy, notice: current.notice, change };
}

/** Everyone on the board, plus whoever this ticket names, in the board's order. */
function mergePeople(people: readonly { id: string; name: string }[], row: NotionRow) {
  const all = [...people];
  row.assigneeIds.forEach((id, i) => {
    if (!all.some((p) => p.id === id)) all.push({ id, name: row.assignees[i] ?? "" });
  });
  return all;
}

type PageBody =
  | { state: "reading"; page: PageMarkdown | null; error: null }
  | { state: "read"; page: PageMarkdown; error: null }
  | { state: "failed"; page: null; error: string };

/**
 * The page's body, read when the ticket opens and again when Notion says it was edited since. The
 * body on screen stays while a newer one is read, so an update does not blank the page.
 */
function usePageBody(
  client: Pick<NotionSourceClient, "pageMarkdown">,
  pageId: string,
  editedAt: string,
): { body: PageBody; replace: (markdown: string) => void } {
  const [body, setBody] = useState<PageBody & { for: string }>({ state: "reading", page: null, error: null, for: pageId });

  useEffect(() => {
    let cancelled = false;
    void client
      .pageMarkdown(pageId)
      .then((page) => {
        if (!cancelled) setBody({ state: "read", page, error: null, for: pageId });
      })
      .catch((cause) => {
        if (!cancelled) setBody({ state: "failed", page: null, error: String(cause), for: pageId });
      });
    return () => {
      cancelled = true;
    };
  }, [client, pageId, editedAt]);

  // Laid in by a save: the page as Notion answered it, without reading it again.
  const replace = useCallback(
    (markdown: string) =>
      setBody((now) => (now.page ? { state: "read", page: { ...now.page, markdown }, error: null, for: now.for } : now)),
    [],
  );
  // Stepping to another ticket shows "reading" at once, not the previous ticket's body.
  return { body: body.for === pageId ? body : ({ state: "reading", page: null, error: null } as PageBody), replace };
}

/**
 * The body editor's state: the draft (null when not editing), and one save at a time. `seen` is
 * always the page as Notion last gave it — a conflict or a partial save moves it on, so the next
 * save is measured from what Notion really has.
 */
function useBodyEditing(
  current: string | null,
  writeBody: ((seen: string, markdown: string) => Promise<BodyOutcome>) | undefined,
  replace: (markdown: string) => void,
) {
  const [draft, setDraft] = useState<string | null>(null);
  // The page as it was when Edit was pressed. Frozen: a sync that reads a newer page while editing
  // must not move it, or Save would be measured from someone else's version and undo their edit
  // with no conflict shown (S32). It moves only with Notion's own answers to this editor.
  const [opened, setOpened] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  const start = () => {
    if (current === null) return;
    setOpened(current);
    setDraft(current);
    setNotice(null);
    setFresh(null);
  };
  const cancel = () => {
    setDraft(null);
    setOpened(null);
    setNotice(null);
    setFresh(null);
  };
  const loadFresh = () => {
    if (fresh === null) return;
    replace(fresh);
    setOpened(fresh);
    setDraft(fresh);
    setFresh(null);
    setNotice(null);
  };
  const save = () => {
    if (!writeBody || opened === null || draft === null || busy) return;
    if (draft === opened) return cancel();
    setBusy(true);
    setNotice(null);
    void writeBody(opened, draft)
      .then((outcome) => {
        switch (outcome.outcome) {
          case "saved":
            replace(outcome.markdown);
            return cancel();
          case "conflict":
            setFresh(outcome.fresh);
            return setNotice("The page was changed in Notion since you opened it. Your edit is kept here; nothing was sent.");
          case "not_saved":
            replace(outcome.fresh);
            setOpened(outcome.fresh);
            return setNotice(`Notion did not take all of it: ${outcome.message} Your edit is kept; Save again sends what is still different.`);
          case "unknown":
          case "refused":
            return setNotice(outcome.message);
        }
      })
      .catch((cause) => setNotice(String(cause)))
      .finally(() => setBusy(false));
  };
  return { draft, setDraft, busy, notice, fresh, start, cancel, save, loadFresh };
}
