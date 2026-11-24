export type CriticVerdict = "pass" | "fail";

// Matches a `VERDICT: PASS` / `verdict = fail` line anywhere, ignoring markup around it.
const VERDICT_RE = /verdict\s*[:=]?\s*\**\s*(pass|fail)/gi;

/**
 * Extracts a critic's boolean verdict from its freeform output. The last verdict wins
 * (the agent's final call after any reasoning). Defaults to FAIL when none is found —
 * default-deny, so an unparseable or evasive critic keeps the gate closed.
 */
export function parseCriticVerdict(text: string): CriticVerdict {
  let verdict: CriticVerdict = "fail";
  for (const match of text.matchAll(VERDICT_RE)) {
    verdict = match[1].toLowerCase() === "pass" ? "pass" : "fail";
  }
  return verdict;
}
