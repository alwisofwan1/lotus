import type { SentReactions, SlackEmojiView, StatusReactions } from "./connectors-api";
import type { EmojiCatalog } from "./emoji-catalog";

/** A state with one emoji; `sent` holds lists, by verdict. */
export type StateKey = Exclude<keyof StatusReactions, "sent">;

/** The states a Slack review request shows, in the order a review goes through them. */
export const REACTION_STATES: { key: StateKey; label: string; hint: string }[] = [
  { key: "taken", label: "Taken in hand", hint: "Also the reaction you add to ask for a review." },
  { key: "queued", label: "Waiting", hint: "Waits for a free slot (up to 3 reviews run at once). Comes off when it starts." },
  { key: "running", label: "Running", hint: "The review runs. Comes off when it ends." },
  { key: "done", label: "Done", hint: "A draft is ready for your Send, or there was nothing to report." },
  { key: "failed", label: "Failed", hint: "The review failed or was stopped." },
  { key: "asked", label: "Asks you", hint: "The agent asks you a question in the Inbox." },
  { key: "skipped", label: "Skipped", hint: "Not reviewed, such as a PR that moved while it waited." },
];

/** The verdicts a sent review can have, each with the emoji it adds. Rust caps a list at 5. */
export const SENT_VERDICTS: { key: keyof SentReactions; label: string; hint: string; placeholder: string }[] = [
  { key: "looksGood", label: "Looks good", hint: "You sent an LGTM or an approval.", placeholder: "white_check_mark" },
  { key: "questions", label: "Questions", hint: "You sent questions for the author.", placeholder: "thinking_face" },
  { key: "changesNeeded", label: "Changes needed", hint: "You sent findings the author must fix.", placeholder: "man-bowing" },
];

/** The most emoji one verdict adds (Rust's MAX_SENT_REACTIONS). */
export const MAX_SENT = 5;

/** A verdict's names as the field shows them: separated by spaces. */
export function namesText(names: string[]): string {
  return names.join(" ");
}

/**
 * The field's text as names. A trailing separator stays as an empty last name, so typing a space
 * after a name is not undone by the next render; Rust drops empty names.
 */
export function parseNames(text: string): string[] {
  return text === "" ? [] : text.split(/[\s,]+/);
}

/** The names that count: cleaned, without blanks and repeats. */
export function cleanNames(names: string[]): string[] {
  return [...new Set(names.map(emojiName).filter(Boolean))];
}

/** The name the way Slack writes it (`:Eyes:` → `eyes`), as Rust stores it. */
export function emojiName(text: string): string {
  return text.trim().replace(/^:+|:+$/g, "").trim().toLowerCase();
}

/** What a name is, once the standard emoji and the workspace's own have loaded. */
export type EmojiLookup = {
  /** The standard emoji's glyph. */
  glyph?: string;
  /** The custom emoji's image. */
  url?: string;
  /**
   * `false` only when both lists are known and the name is in neither, so Slack will probably refuse
   * it. `true` is a match; `null` is not knowing (a list is still loading, or Slack withheld it).
   */
  known: boolean | null;
};

/** Skin tones are a suffix Slack takes on any person emoji (`thumbsup::skin-tone-2`). */
function baseName(name: string): string {
  return name.replace(/::skin-tone-[2-6](?:::skin-tone-[2-6])?$/, "");
}

export function lookupEmoji(
  text: string,
  catalog: EmojiCatalog | null,
  custom: SlackEmojiView | null,
): EmojiLookup {
  const name = baseName(emojiName(text));
  if (!name) return { known: null };
  const entry = custom?.emoji.find((e) => e.name === name);
  if (entry?.url) return { url: entry.url, known: true };
  const standard = catalog?.glyphs.get(entry?.aliasOf ?? name);
  if (standard) return { glyph: standard, known: true };
  if (entry) return { known: true };
  return { known: catalog && custom?.state === "ok" ? false : null };
}

/** What a reaction looks like, as text: the glyph when known, else `:name:`; "" when off. */
export function emojiPreview(text: string, catalog: EmojiCatalog | null = null, custom: SlackEmojiView | null = null): string {
  const name = emojiName(text);
  return name ? (lookupEmoji(name, catalog, custom).glyph ?? `:${name}:`) : "";
}

export function sameReactions(a: StatusReactions, b: StatusReactions): boolean {
  return (
    REACTION_STATES.every(({ key }) => emojiName(a[key]) === emojiName(b[key])) &&
    SENT_VERDICTS.every(({ key }) => cleanNames(a.sent?.[key] ?? []).join(" ") === cleanNames(b.sent?.[key] ?? []).join(" "))
  );
}
