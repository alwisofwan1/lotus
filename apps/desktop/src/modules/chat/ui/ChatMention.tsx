"use client";

import { Node } from "@tiptap/core";
import { FileText, Folder, MessageSquare } from "lucide-react";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { EditorListEntry } from "@/lib/tauri/codespace";
import { filterFiles, withFolders } from "../domain/files";
import { chatMentionText, filterChats, pathQuery, tildePath, type MentionChat } from "../domain/mention";
import { homeFolder, listChatPath } from "../runtime/chat-runtime-client";
import { folderName } from "../domain/rail";
import { activeTrigger } from "../domain/trigger";

// The `@` picker, anywhere in the message: other chats, then files and folders. Wears the `/`
// picker's look (`.chat-slash*`). Plan: plans/chat-inline-mentions/PLAN.md.

const LIMIT = 50;

export interface MentionOptions {
  /** Paths relative to the chat's folder. */
  files: readonly string[];
  /** The folder had more files than were read: some paths are missing. */
  truncated?: boolean;
  /** Files this thread changed; a bare `@` offers them first. */
  changed?: ReadonlySet<string>;
  /** Other chats to name; the agent reads one with `lotus_chat_read`. Empty for an agent without tools. */
  chats?: readonly (MentionChat & { cwd: string })[];
  /** The chat being typed in, left out of `chats`. */
  current?: string | null;
  /** The chat's folder: `@./` and `@../` start from it. */
  cwd?: string | null;
  /** False while the composer cannot send: `@` is plain text then. */
  enabled: boolean;
  /** Replace the `typed` chars before the caret with `text`; `chip` lets a rich editor show the pick
   *  as a chip that still sends `text`. */
  onInsert: (text: string, typed: number, chip?: MentionChip) => void;
}

export interface MentionChip {
  kind: "chat" | "folder" | "file";
  label: string;
  /** What the agent gets. */
  text: string;
}

/** Keep the identifying file or folder name visible; the full path stays in the tooltip and message. */
function mentionLabel(kind: MentionChip["kind"], label: string): string {
  if (kind === "chat") return label;
  const folder = label.endsWith("/");
  const name = label.replace(/\/$/, "").split("/").pop();
  return name ? `${name}${folder ? "/" : ""}` : label;
}

/** A pick as one block in the Tiptap composer: shows the name, sends the full text (`renderText`). */
export const MentionNode = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ kind: { default: "file" }, label: { default: "" }, text: { default: "" } }),
  parseHTML: () => [{ tag: "span[data-mention]" }],
  renderHTML: ({ node }) => [
    "span",
    { "data-mention": "", "data-kind": node.attrs.kind, class: "chat-mention", contenteditable: "false", title: node.attrs.text },
    mentionLabel(node.attrs.kind, node.attrs.label),
  ],
  renderText: ({ node }) => node.attrs.text,
});

interface MentionRow {
  key: string;
  kind: "chat" | "folder" | "file";
  name: string;
  detail: string;
  /** What the pick inserts. */
  text: string;
  /** What its chip shows. */
  label: string;
}

/** `path` is relative to the chat folder, or absolute for an `@` typed as a path. */
function fileRow(path: string, home: string | null = null): MentionRow {
  const folder = path.endsWith("/");
  const bare = folder ? path.slice(0, -1) : path;
  const cut = bare.lastIndexOf("/") + 1;
  return { key: path, kind: folder ? "folder" : "file", name: path.slice(cut), detail: tildePath(bare.slice(0, cut), home), text: `\`${path}\``, label: tildePath(path, home) };
}

/** A folder's entries whose names start with `name`, then those that contain it. */
function pathRows(entries: readonly EditorListEntry[], name: string, home: string | null): MentionRow[] {
  const q = name.toLowerCase();
  const rows = entries.flatMap((e) => {
    const base = e.path.slice(e.path.lastIndexOf("/") + 1).toLowerCase();
    const rank = base.startsWith(q) ? 0 : base.includes(q) ? 1 : -1;
    return rank < 0 ? [] : [{ row: fileRow(e.kind === "directory" ? `${e.path}/` : e.path, home), rank }];
  });
  return rows.sort((a, b) => a.rank - b.rank).slice(0, LIMIT).map(({ row }) => row);
}

export type MentionPicker = ReturnType<typeof useMentionPicker>;

/** Same contract as `useSlashPicker`: the editor reports the text before the caret with `track()`
 *  and forwards keys to `keyDown()` first. A file becomes `` `path` ``, the Files pane's format. */
export function useMentionPicker({ files, truncated = false, changed, chats, current = null, cwd = null, enabled, onInsert }: MentionOptions) {
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [listing, setListing] = useState<{ dir: string; entries: EditorListEntry[] } | null>(null);
  const entries = useMemo(() => withFolders(files), [files]);
  const path = enabled && query !== null ? pathQuery(query, cwd, home) : null;
  const wantsHome = enabled && home === null && !!query?.startsWith("~/");

  useEffect(() => {
    if (!wantsHome) return;
    let live = true;
    homeFolder().then((h) => live && setHome(h), () => {});
    return () => {
      live = false;
    };
  }, [wantsHome]);

  const dir = path?.dir ?? null;
  useEffect(() => {
    if (!dir) return;
    let live = true;
    // A folder that cannot be read lists nothing; the popover says no match.
    listChatPath(dir).then(
      (list) => live && setListing({ dir, entries: list }),
      () => live && setListing({ dir, entries: [] }),
    );
    return () => {
      live = false;
    };
  }, [dir]);

  const matches = useMemo((): MentionRow[] => {
    if (!enabled || query === null) return [];
    if (path) return listing?.dir === path.dir ? pathRows(listing.entries, path.name, home) : [];
    // Few, and named on purpose, so they lead; fewer before anything is typed.
    const chatRows = filterChats(chats ?? [], query, current, query ? 5 : 3).map(
      (c): MentionRow => ({ key: `chat:${c.id}`, kind: "chat", name: c.title ?? "", detail: folderName(c.cwd), text: chatMentionText(c.title ?? "", c.id), label: c.title ?? "" }),
    );
    // Bare `@`: what this thread touched, then the folder's top level.
    const paths = query
      ? filterFiles(entries, query, LIMIT)
      : [...new Set([...(changed ?? []), ...entries.filter((p) => !p.replace(/\/$/, "").includes("/"))])].slice(0, LIMIT);
    return [...chatRows, ...paths.map((p) => fileRow(p))];
  }, [enabled, entries, changed, chats, current, query, path, listing, home]);
  // Open with no match too, so a miss says so (and how to reach other folders) instead of vanishing.
  const open = enabled && query !== null && !dismissed;
  const activeIndex = Math.max(0, matches.findIndex((m) => m.key === activeKey));

  const pick = (row: MentionRow, typed = (query?.length ?? 0) + 1) => {
    setQuery(null);
    setActiveKey(null);
    onInsert(`${row.text} `, typed, { kind: row.kind, label: row.label, text: row.text });
  };

  return {
    id,
    open,
    truncated,
    /** The query is a path: rows are one folder's entries, Tab opens a folder. */
    pathMode: path !== null,
    query: query ?? "",
    matches,
    activeIndex,
    optionId: (index: number) => `${id}-o${index}`,
    inputAria: {
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? `${id}-list` : undefined,
      "aria-activedescendant": open && matches.length > 0 ? `${id}-o${activeIndex}` : undefined,
    },
    track(beforeCaret: string) {
      const trigger = activeTrigger(beforeCaret);
      const next = trigger?.char === "@" ? trigger.query : null;
      if (next === null) setDismissed(false);
      if (next !== query) setActiveKey(null);
      setQuery(next);
    },
    setActive: (key: string) => setActiveKey(key),
    pick: (row: MentionRow) => pick(row),
    /** Any file on disk, from the system dialog; it replaces the typed `@query`. */
    async browse() {
      const typed = (query?.length ?? 0) + 1;
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const picked = await openDialog({ multiple: false, directory: false, title: "Mention a file" });
      if (typeof picked === "string") pick(fileRow(picked, home), typed);
    },
    /** True when the key was the picker's; the editor then does nothing with it. */
    keyDown(key: string, shift = false): boolean {
      if (!open) return false;
      if (key === "Escape") {
        setDismissed(true);
        return true;
      }
      // Nothing to pick: Enter sends, Tab moves on, as if the picker were closed.
      if (matches.length === 0) return false;
      const row = matches[activeIndex];
      if (key === "Tab" && !shift && path && row.kind === "folder") {
        onInsert(`@${path.typedDir}${row.name}/`, (query?.length ?? 0) + 1);
        return true;
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        const step = key === "ArrowDown" ? 1 : -1;
        setActiveKey(matches[(activeIndex + step + matches.length) % matches.length].key);
        return true;
      }
      if ((key === "Enter" || key === "Tab") && !shift) {
        pick(row);
        return true;
      }
      return false;
    },
  };
}

const ICONS = { chat: MessageSquare, folder: Folder, file: FileText } as const;

export function MentionPopover({ mention, place }: { mention: MentionPicker; place: "above" | "below" }) {
  const listRef = useRef<HTMLDivElement>(null);
  const { open, matches, activeIndex } = mention;

  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[id="${mention.optionId(activeIndex)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, mention]);

  if (!open) return null;
  const files = matches.filter((m) => m.kind !== "chat").length;
  const count = `${matches.length}${files === LIMIT ? "+" : ""} ${matches.length === 1 ? "result" : "results"}`;
  // Same order as `matches`, so the arrows walk the rows top to bottom.
  const groups = [
    { label: "Chats", rows: matches.map((m, index) => ({ m, index })).filter(({ m }) => m.kind === "chat") },
    { label: "Files", rows: matches.map((m, index) => ({ m, index })).filter(({ m }) => m.kind !== "chat") },
  ].filter((g) => g.rows.length > 0);
  return (
    <div className="chat-slash" data-place={place} onMouseDown={(event) => event.preventDefault()}>
      <div className="chat-slash-head">
        <span className="chat-slash-query">@{mention.query}</span>
        <span className="chat-slash-count">{mention.truncated ? `${count} · big folder, some files not listed` : count}</span>
      </div>
      <div ref={listRef} id={`${mention.id}-list`} className="chat-slash-list" role="listbox" aria-label="Chats and files">
        {groups.map((g) => (
          <Fragment key={g.label}>
            {groups.length > 1 && (
              <div className="chat-slash-group" role="presentation">
                {g.label} <span>{g.rows.length}</span>
              </div>
            )}
            {g.rows.map(({ m, index }) => {
              const Icon = ICONS[m.kind];
              return (
                <div
                  key={m.key}
                  id={mention.optionId(index)}
                  className="chat-slash-row"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-kind={m.kind}
                  onMouseMove={() => index !== activeIndex && mention.setActive(m.key)}
                  onClick={() => mention.pick(m)}
                >
                  <Icon className="chat-slash-icon" size={14} aria-hidden />
                  <span className="chat-slash-name">{m.name}</span>
                  <span className="chat-slash-desc">{m.detail}</span>
                  <span className="chat-slash-act" aria-hidden>
                    add ⏎
                  </span>
                </div>
              );
            })}
          </Fragment>
        ))}
        {matches.length === 0 && (
          <div className="chat-slash-empty" role="presentation">
            <b>@{mention.query}</b>
            <p>{mention.pathMode ? "Nothing in this folder matches." : "No chat or file in this folder matches."}</p>
            <p className="chat-slash-quiet">
              {mention.pathMode ? "Keep typing to send it as plain text." : "Other folders: start with / ~/ or ../ — or Browse."}
            </p>
          </div>
        )}
      </div>
      <div className="chat-slash-keys">
        <span aria-hidden>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span aria-hidden>
          <kbd>⏎</kbd> pick
        </span>
        {mention.pathMode && (
          <span aria-hidden>
            <kbd>⇥</kbd> open folder
          </span>
        )}
        <span aria-hidden>
          <kbd>esc</kbd> close
        </span>
        <button type="button" className="chat-slash-browse" onClick={() => void mention.browse()}>
          Browse…
        </button>
      </div>
    </div>
  );
}
