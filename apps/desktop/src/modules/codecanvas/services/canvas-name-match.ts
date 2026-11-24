// Shared normalization for matching a free-form NL/agent target ("Close Iris.",
// "ask 'Sage'", "focus Rowan!") against a node/agent display name. Lowercases,
// strips surrounding quotes, and drops trailing sentence punctuation — so a name
// lifted from natural speech resolves to the node the user clearly meant. Kept
// dependency-free so every resolver (NL command, agent messaging, canvas-control)
// can share it without import cycles.
export function normalizeNameQuery(name: string): string {
  return name
    .trim()
    .replace(/^['"`“”‘’]+/, "")
    .replace(/['"`“”‘’]+$/, "")
    .replace(/[.,!?;:]+$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Spoken number words (English + Bahasa Indonesia) → digits, plus the common STT slip "too" → "2".
 * Voice dictation writes "Browser two" / "Browser too" for "Browser 2"; folding both sides to a
 * canonical digit form lets those resolve by exact match instead of failing. Closed-class and tiny.
 */
const NUMBER_WORD_TO_DIGIT: Record<string, string> = {
  one: "1", two: "2", too: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  satu: "1", dua: "2", tiga: "3", empat: "4", lima: "5", enam: "6", tujuh: "7", delapan: "8", sembilan: "9", sepuluh: "10",
};

/**
 * Normalize + fold spoken number words to digits, for a transcription-tolerant name match tier. Applied
 * to BOTH the query and the candidate name so "Browser two"/"browser too" match "Browser 2".
 */
export function foldForMatch(name: string): string {
  return normalizeNameQuery(name)
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .map((word) => NUMBER_WORD_TO_DIGIT[word] ?? word)
    .join(" ");
}
