// What is typed but not sent, per thread (and per Start screen), so opening another chat and
// coming back — or a reload — finds it where it was left. The editor's JSON keeps `@` chips.

import type { JSONContent } from "@tiptap/core";

import type { SlashItem } from "./slash";
import type { Attachment } from "./thread-event";

export interface ComposerDraft {
  doc: JSONContent | null;
  attachments: Attachment[];
  /** The skill chip before the text, if one was picked. */
  skill?: SlashItem | null;
}

const PREFIX = "lotus.chat.draft.";

/** Fired on `window` when a draft starts or stops existing (not on every keystroke); the rail listens. */
export const DRAFTS_CHANGED = "lotus:composer-drafts";

function setStored(storageKey: string, value: string | null) {
  const had = localStorage.getItem(storageKey) !== null;
  if (value === null) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, value);
  if (had !== (value !== null) && typeof window !== "undefined") window.dispatchEvent(new Event(DRAFTS_CHANGED));
}

export function readComposerDraft(key: string): ComposerDraft | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFIX + key) ?? "null") as Partial<ComposerDraft> | null;
    if (!saved || typeof saved !== "object") return null;
    return { doc: saved.doc ?? null, attachments: Array.isArray(saved.attachments) ? saved.attachments : [], skill: saved.skill ?? null };
  } catch {
    return null;
  }
}

/** Nothing typed and nothing attached removes the draft. */
export function writeComposerDraft(key: string, draft: ComposerDraft): void {
  try {
    setStored(PREFIX + key, !draft.doc && draft.attachments.length === 0 && !draft.skill ? null : JSON.stringify(draft));
  } catch {
    // Storage full or off: the draft lives only while the composer is mounted, as before.
  }
}

export function clearComposerDraft(key: string): void {
  writeComposerDraft(key, { doc: null, attachments: [] });
}

/** Drops thread drafts whose thread is gone (deleted by an agent, the bb CLI, another window).
 *  `threadIds` must be the whole list; the Start screen's drafts are kept. */
export function pruneComposerDrafts(threadIds: readonly string[]): void {
  try {
    const keep = new Set(threadIds.map((id) => PREFIX + id));
    const gone: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX) && !key.startsWith(PREFIX + "start:") && !keep.has(key)) gone.push(key);
    }
    gone.forEach((key) => setStored(key, null));
  } catch {
    // Storage off: nothing was kept to prune.
  }
}

/** Thread ids that hold a draft (Start drafts left out). */
export function draftThreadIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX) && !key.startsWith(PREFIX + "start:")) ids.add(key.slice(PREFIX.length));
    }
  } catch {
    // Storage off: no drafts.
  }
  return ids;
}

/** What the rail's tooltip says of a draft: `/skill`, the text with chips as their labels, and the files. */
export function draftPreview(draft: ComposerDraft, max = 60): string {
  const parts: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "text") parts.push(node.text ?? "");
    else if (node.type === "mention") parts.push(String(node.attrs?.label ?? ""));
    else if (node.type === "paragraph" && parts.length > 0) parts.push(" ");
    node.content?.forEach(walk);
  };
  if (draft.doc) walk(draft.doc);
  const text = [draft.skill ? `/${draft.skill.name}` : "", parts.join("").replace(/\s+/g, " ").trim()].filter(Boolean).join(" ");
  const cut = text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  const files = draft.attachments.length;
  return [cut, files ? `${files} file${files === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
}
