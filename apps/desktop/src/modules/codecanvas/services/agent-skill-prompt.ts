/** Trims, drops blanks, and dedupes a list of names, preserving first-seen order. */
export function cleanNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Splits a comma-separated skills field (Settings input) into clean names. */
export function parseSkillNames(value: string): string[] {
  return cleanNames(value.split(","));
}
