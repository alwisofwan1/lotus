/**
 * Selected-text transform (ADR-0034, Option D — SuperWhisper "Selected Text Context"). When a note is
 * the Focused Node and text is selected, a spoken/typed instruction ("make this bullets", "translate
 * to English", "shorten this") rewrites the selection in place. This is the pure core: build the
 * prompt, run it, and — unlike dictation polish — FAIL CLOSED (return null) on error/empty so a flaky
 * model never overwrites the user's selection with garbage. `callModel` is injected for testability.
 */

/** Build the transform prompt. Pure + testable. */
export function buildSelectionTransformPrompt(instruction: string, selection: string): string {
  return [
    "You transform a snippet of the user's note according to their instruction.",
    "Apply ONLY the instruction to the snippet — do not answer it, explain it, or add commentary.",
    "Preserve the snippet's language unless the instruction is to translate.",
    "You may use Markdown (lists, emphasis) when the instruction calls for it.",
    "Output ONLY the transformed snippet — no quotes, no preamble.",
    "",
    `Instruction: ${instruction.trim()}`,
    "",
    "Snippet:",
    selection.trim(),
  ].join("\n");
}

function unwrapQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Transform `selection` per `instruction`. Returns the new text, or `null` when there is nothing to do
 * (empty selection/instruction) or the model errors/returns empty — the caller must treat `null` as
 * "leave the selection untouched" (fail closed).
 */
export async function transformSelection(
  selection: string,
  instruction: string,
  callModel: (prompt: string) => Promise<string>,
): Promise<string | null> {
  const sel = selection.trim();
  const ins = instruction.trim();
  if (!sel || !ins) return null;
  try {
    const out = unwrapQuotes(await callModel(buildSelectionTransformPrompt(ins, sel)));
    return out || null;
  } catch {
    return null;
  }
}
