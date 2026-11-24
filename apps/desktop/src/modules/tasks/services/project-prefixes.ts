import { uniqueTaskPrefix } from "@/modules/tasks/services/task-key";

/**
 * Handing each project the prefix it keeps.
 *
 * Pure, and separate from the hook that stores the answer, because the decision is the part worth
 * testing: a prefix must be assigned ONCE and never move, or every key ever spoken or pasted stops
 * pointing at the task it named.
 *
 * Three rules, and each of them is a way the naive version goes wrong:
 *
 *  1. **An existing prefix is never re-derived.** Renaming a folder from `interview-hss` to
 *     `interviews` must not turn `IH-2` into `INT-2`.
 *  2. **A new prefix avoids every prefix already taken**, including ones belonging to projects
 *     that are not in this list any more — a closed workspace can be reopened, and its old keys
 *     are still written down somewhere.
 *  3. **Assignment is order-stable.** Given the same projects in the same order, the same
 *     prefixes come out, so two windows do not disagree about what `LOT2` means.
 */

export interface PrefixAssignment {
  /** The full map to store: what was already there, plus whatever this call had to invent. */
  prefixes: Record<string, string>;
  /** True when something was added, so a caller can skip a write that changes nothing. */
  changed: boolean;
}

export function assignProjectPrefixes(
  projects: readonly { id: string; name: string }[],
  stored: Readonly<Record<string, string>>,
): PrefixAssignment {
  const prefixes: Record<string, string> = { ...stored };
  // Every prefix in play, including projects not in this list: a prefix that was handed out once
  // stays spent.
  const taken = new Set(Object.values(prefixes).map((prefix) => prefix.toUpperCase()));
  let changed = false;

  for (const project of projects) {
    if (prefixes[project.id]) continue;
    const prefix = uniqueTaskPrefix(project.name, taken);
    // A project whose name yields nothing (only punctuation, or an emoji) gets no prefix rather
    // than a made-up one; its tasks simply show no key until it is renamed.
    if (!prefix) continue;
    prefixes[project.id] = prefix;
    taken.add(prefix);
    changed = true;
  }

  return { prefixes, changed };
}
