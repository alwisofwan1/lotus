/**
 * Counts colour literals in a stylesheet — the measure behind the colour-literal budget
 * (color-literal-budget.css.test.ts, rules in src/styles/README.md).
 *
 * A literal is a hex colour of 3, 4, 6 or 8 digits, or an `rgb()`/`rgba()`/`hsl()`/`hsla()` call.
 * Every occurrence counts, so `linear-gradient(#000, #fff)` is two. Literals inside comments do
 * not count: a commented-out colour paints nothing. A line carrying
 * `/* color-literal-ok: <reason> *\/` is exempt; a marker without a reason exempts nothing and is
 * reported, so the exemption cannot be taken silently.
 *
 * A marker is a comment that opens with `color-literal-ok:`. It may run onto further lines (the
 * reason is everything after the colon, up to `*\/`), and it exempts the line it opens on. The words
 * further inside some other comment are prose, not a marker.
 *
 * Deliberately a text scan, not a parser: an id selector that happens to spell hex (`#bad`) would
 * count. None exists in app CSS today; if one appears, rename it rather than teach this function
 * selectors.
 */

const HEX = /#([0-9a-fA-F]{3,8})(?![\w-])/g;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?)\(/gi;
const COMMENT = /\/\*[\s\S]*?\*\//g;
const EXEMPT_MARKER = /^\/\*\s*color-literal-ok:([\s\S]*)\*\/$/;

export interface ColorLiteralCount {
  /** Literals that count against the file's budget. */
  count: number;
  /** Literals on lines exempted with a reasoned marker. */
  exempted: number;
  /** 1-based line numbers of markers that give no reason. */
  markersWithoutReason: number[];
}

export function countColorLiterals(css: string): ColorLiteralCount {
  // Each marker by the 0-based line it opens on: true when it gives a reason.
  const markers = new Map<number, boolean>();
  // Blank comments but keep their newlines, so line numbers still match the source.
  const code = css.replace(COMMENT, (comment, offset: number) => {
    const marker = EXEMPT_MARKER.exec(comment);
    if (marker) {
      const line = css.slice(0, offset).split("\n").length - 1;
      markers.set(line, markers.get(line) === true || marker[1].trim() !== "");
    }
    return comment.replace(/[^\n]/g, " ");
  });
  const result: ColorLiteralCount = { count: 0, exempted: 0, markersWithoutReason: [] };

  code.split("\n").forEach((line, index) => {
    const literals =
      [...line.matchAll(HEX)].filter((m) => [3, 4, 6, 8].includes(m[1].length)).length +
      [...line.matchAll(COLOR_FUNCTION)].length;
    const marker = markers.get(index);
    if (marker === false) result.markersWithoutReason.push(index + 1);
    if (marker === true) result.exempted += literals;
    else result.count += literals;
  });

  return result;
}

/**
 * One message per file that is off its baseline, in either direction. A file absent from the
 * baseline has a budget of zero; a count below the baseline fails too, so the saving is locked in
 * by lowering the number in the same commit.
 */
export function compareToBaseline(
  counts: Record<string, number>,
  baseline: Record<string, number>,
): string[] {
  const problems: string[] = [];
  for (const [file, count] of Object.entries(counts)) {
    const budget = baseline[file] ?? 0;
    if (count > budget) {
      problems.push(
        `${file}: ${count} colour literals, baseline ${budget} (+${count - budget}). Use a token, or exempt the line with a reason.`,
      );
    } else if (count < budget) {
      problems.push(
        `${file}: ${count} colour literals, baseline ${budget} (-${budget - count}). Lower the baseline to ${count} in this commit.`,
      );
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!(file in counts)) problems.push(`${file}: in the baseline but not found. Remove the entry.`);
  }
  return problems;
}
