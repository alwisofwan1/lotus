/** Mirror the desktop roster locally to preserve the one-way desktop-to-host dependency. */

/** Use names that speech recognition can distinguish reliably. */
export const CELL_NAME_POOL: readonly string[] = [
  "Atlas",
  "Nova",
  "Kai",
  "Juno",
  "Orion",
  "Vega",
  "Lyra",
  "Milo",
  "Ezra",
  "Nia",
  "Remy",
  "Soren",
  "Cleo",
  "Dara",
  "Faye",
  "Gio",
  "Hana",
  "Ivo",
  "Tao",
  "Zia",
];

/** Case- and whitespace-insensitive, because "kai" and "Kai " are the same name to a person. */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** Choose names deterministically so restarts don't reshuffle the fleet. */
export function nextCellName(
  taken: Iterable<string>,
  pool: readonly string[] = CELL_NAME_POOL,
): string {
  const used = new Set<string>();
  for (const name of taken) used.add(normalize(name));

  for (const candidate of pool) {
    if (!used.has(normalize(candidate))) return candidate;
  }

  for (let n = 1; ; n++) {
    const candidate = `Agent ${n}`;
    if (!used.has(normalize(candidate))) return candidate;
  }
}
