/**
 * What a cell is called when whoever started it did not say.
 *
 * **This exists because of what the alternative produced.** A headless cell's title used to fall
 * back to the bridge's own `runnerLabel`, so every claude cell started from the phone was called
 * literally *Claude Code* — a brand, not a name. Two of them in one fleet were indistinguishable:
 * the desktop's ⌘K offered "Adopt Claude Code" twice and an adopted node carried the same label,
 * while a push notification read "Claude Code needs you" for whichever one it was. The field is
 * documented as the *persona* name (`FleetMember.title`), and the contract fixtures have always
 * shown persona names there — `Chase`, `Marshall` — so the fallback was never what the shape meant.
 *
 * `runnerLabel` is not lost by this: it is its own field, and a client that wants to say which
 * runner a cell is reads that. Which is the point — the two questions had one answer.
 *
 * **A deliberate copy, not an import.** The desktop draws canvas agents from
 * `apps/desktop/src/lib/agent-catalog/name-pool.ts`, and the dependency direction here is one-way
 * (desktop → host, never the reverse), so the host cannot reach for it. The names are copied so an
 * adopted cell reads like every other agent on the canvas it lands on; keep the two rosters in step
 * the way `types/fleet.ts` keeps its shape in step with the Rust side.
 */

/**
 * Neutral, short, globally pronounceable, in assignment order.
 *
 * Pronounceability is not decoration: these names are spoken at an agent ("Kai, run the tests"),
 * transcribed by STT, and matched back to a cell by name, so one that is hard to say or easy to
 * mishear silently misfires the command.
 */
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

/**
 * The first pool name nobody is using, else `Agent N` for the smallest free `N`.
 *
 * Deterministic — same `taken`, same answer — so a test can assert the name and a restart does not
 * shuffle the fleet. Never throws and never returns a name already in `taken`.
 */
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
