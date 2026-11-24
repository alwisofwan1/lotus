/**
 * The name a task is called by out loud.
 *
 * `INT-2` is the whole reason bb's list reads the way it does: it is short enough to say in a
 * sentence, stable enough to paste into a commit message, and it carries which project the task
 * belongs to without a second column. A uuid does none of that — Lotus's task ids are
 * `task_<12 hex>`, which is an address, not a name.
 *
 * Two rules make it worth having, and both are enforced here rather than left to callers:
 *
 *  1. **The prefix belongs to the project, the number to the task.** A key is only unique because
 *     no two projects share a prefix, which is what {@link uniqueTaskPrefix} is for.
 *  2. **A number is never reused.** That is the store's job, not this file's — but it is why
 *     nothing here derives a number from a position in a list. A key that changed when an earlier
 *     task was deleted would be a name that lies about which task it names.
 */

/** How many letters a derived prefix takes. Three is what bb's own projects use ("Test" → TES). */
const PREFIX_LENGTH = 3;
const MAX_PREFIX_LENGTH = 6;

/**
 * A prefix from a project's name.
 *
 * Letters and digits only, uppercased: a prefix goes in a key that people type, and a key with a
 * hyphen or a space in its prefix cannot be parsed back. A name with several words takes their
 * initials first — "Lotus Pocket" reads better as `LP` than as `LOT` — and a single word takes its
 * first three letters.
 *
 * An empty answer is possible (a name of only punctuation, or an emoji) and is returned as such:
 * the caller decides what to do about a project that cannot name itself, which is a question about
 * that project, not about this function.
 */
export function deriveTaskPrefix(projectName: string): string {
  const words = projectName
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter(Boolean);

  if (words.length === 0) return "";

  if (words.length >= 2) {
    const initials = words
      .slice(0, MAX_PREFIX_LENGTH)
      .map((word) => word[0])
      .join("");
    return initials.toUpperCase().slice(0, MAX_PREFIX_LENGTH);
  }

  return words[0].toUpperCase().slice(0, PREFIX_LENGTH);
}

/**
 * The same prefix, made unique against the ones already taken.
 *
 * Collisions are ordinary — `lotus` and `lotus-host` both derive `LOT` — and the answer is a
 * number, not a different set of letters: `LOT2` still reads as that project, while a
 * re-derivation ("LTH"?) would be a name nobody would guess.
 *
 * Comparison is case-insensitive because a prefix is uppercase by construction, and a store that
 * accepted `lot` beside `LOT` would hand two projects the same spoken key.
 */
export function uniqueTaskPrefix(projectName: string, taken: Iterable<string>): string {
  const base = deriveTaskPrefix(projectName);
  if (!base) return "";

  const used = new Set([...taken].map((prefix) => prefix.trim().toUpperCase()));
  if (!used.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  // A thousand projects sharing three letters is not a case to design for, but returning a
  // duplicate silently would be worse than returning something plainly odd.
  return `${base}${Date.now().toString(36).toUpperCase()}`;
}

/**
 * The key, when the task has a number.
 *
 * `null` rather than a placeholder for a task that has none: Lotus's store did not number tasks
 * until this work, and a row that showed `INT-?` would be asserting a key that cannot be typed
 * back. The list draws nothing there instead.
 */
export function formatTaskKey(prefix: string, number: number | undefined): string | null {
  const cleanPrefix = prefix.trim().toUpperCase();
  if (!cleanPrefix) return null;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
  return `${cleanPrefix}-${number}`;
}

export interface ParsedTaskKey {
  prefix: string;
  number: number;
}

/**
 * Read a key someone typed or pasted.
 *
 * Case-insensitive on the way in and uppercase on the way out, so `int-2` finds the same task as
 * `INT-2`. Surrounding whitespace is tolerated because this is fed by paste as often as by typing.
 */
export function parseTaskKey(raw: string): ParsedTaskKey | null {
  const match = /^\s*([\p{L}\p{N}]+)-(\d+)\s*$/u.exec(raw);
  if (!match) return null;
  const number = Number.parseInt(match[2], 10);
  if (!Number.isInteger(number) || number < 1) return null;
  return { prefix: match[1].toUpperCase(), number };
}
