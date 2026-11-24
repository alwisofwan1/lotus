/**
 * A conversation's title, the same in every mode (mockups/conversation-title-everywhere.html).
 *
 * Code panes, Chat threads and Canvas sessions each STORE their title where they always did
 * (`cell.title`, `thread.title`, `session.title`); what they share is how it is shown, how a
 * rename is read, and what the menu says about where the name came from. Pure, so the rules are
 * tested once and not per surface.
 */

/**
 * Where a title came from.
 *
 * `prompt`: the first message's line, before any model refined it.
 * `auto`: the agent's own title or a model's.
 * `manual`: a person typed it, and nothing automatic overwrites it.
 */
export type TitleSource = "prompt" | "auto" | "manual";

/** Chat's rename field cap, kept for every mode so a name typed in one fits in the others. */
export const MAX_TITLE_CHARS = 80;

/** A title as drawn: links dropped, first letter capitalised. A title that is only a link stays as it is. */
export function displayTitle(title: string): string {
  const tidy = title.replace(/\s*\bhttps?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return tidy ? tidy[0].toLocaleUpperCase() + tidy.slice(1) : title;
}

/**
 * What a finished rename asks for: `null` changes nothing, `""` hands the title back to the
 * automatic one, anything else is the new name (one line, capped).
 */
export function renameRequest(draft: string, current: string): string | null {
  const next = draft.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
  if (next === current.trim()) return null;
  return next;
}

/** The first line of the title menu, so "Regenerate" changing nothing is never a mystery. */
export function titleSourceLabel(source: TitleSource): string {
  switch (source) {
    case "prompt":
      return "From the first message";
    case "auto":
      return "Named automatically";
    case "manual":
      return "Renamed by you · kept as typed";
  }
}
