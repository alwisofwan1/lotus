/**
 * `@` naming another chat. The agent reads it with `lotus_chat_read`; checked 2026-11-01: Claude
 * given `chat "ingat kata mango" (chatId …)` mid-sentence called the tool and answered from it.
 * Plan: plans/chat-inline-mentions/PLAN.md.
 */

export interface MentionChat {
  id: string;
  title: string | null;
  updatedAt: number;
  archived: boolean;
}

/** Chats `@` offers: titled, not archived, not `except`; titles that start with the query first,
 *  then titles that contain it, newest first within each. */
export function filterChats<T extends MentionChat>(chats: readonly T[], query: string, except: string | null, limit: number): T[] {
  const q = query.trim().toLowerCase();
  return chats
    .flatMap((c) => {
      if (c.archived || c.id === except || !c.title) return [];
      const title = c.title.toLowerCase();
      const rank = !q ? 1 : title.startsWith(q) ? 0 : title.includes(q) ? 1 : -1;
      return rank < 0 ? [] : [{ c, rank }];
    })
    .sort((a, b) => a.rank - b.rank || b.c.updatedAt - a.c.updatedAt)
    .slice(0, limit)
    .map(({ c }) => c);
}

/** The text a picked chat becomes: one line, no inner double quotes, short title. */
export function chatMentionText(title: string, id: string): string {
  const clean = title.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return `chat "${clean.length > 60 ? `${clean.slice(0, 59)}…` : clean}" (chatId ${id})`;
}

/** A `@` query typed as a path: from the disk root (`/`), home (`~/`) or the chat folder (`./`,
 *  `../`). `dir` is the folder to list, absolute, ending in `/`; `name` is the part after it. */
export interface PathQuery {
  dir: string;
  name: string;
  /** What was typed up to `name`, so a folder can be opened in the user's own spelling. */
  typedDir: string;
}

export function pathQuery(query: string, cwd: string | null, home: string | null): PathQuery | null {
  let base: string | null;
  if (query.startsWith("/")) base = "";
  else if (query.startsWith("~/")) base = home;
  else if (query.startsWith("./") || query.startsWith("../")) base = cwd;
  else return null;
  if (base === null) return null;
  const cut = query.lastIndexOf("/") + 1;
  const typedDir = query.slice(0, cut);
  const rel = query.startsWith("~/") ? typedDir.slice(2) : typedDir;
  const parts: string[] = [];
  for (const part of `${base}/${rel}`.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return { dir: `/${parts.map((p) => `${p}/`).join("")}`, name: query.slice(cut), typedDir };
}

/** `/Users/me/x` → `~/x`, for labels; the agent always gets the full path. */
export function tildePath(path: string, home: string | null): string {
  const h = home?.replace(/\/+$/, "");
  return h && (path === h || path.startsWith(`${h}/`)) ? `~${path.slice(h.length)}` : path;
}
