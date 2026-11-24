/** Added and removed lines in a unified diff; the `+++` / `---` file headers are not lines. */
export function countDiffLines(content: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}
