// Splits a reply that is still streaming into a settled part, which no later token can change,
// and the tail that is still being written. The UI parses the settled part once and re-parses only
// the tail per token (bb `streaming-markdown-split.ts`, MIT, same idea).
//
// The cut is the last blank line outside a code fence: a blank line ends every block except a
// fenced code block.
// ponytail: a loose list or a reference-style link that spans the cut renders split until the
// reply finishes; a finished reply is parsed whole, so the final text is always right.

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export function splitStreamingMarkdown(text: string): { settled: string; tail: string } {
  let fence: string | null = null;
  let cut = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence === null) {
      if (marker) fence = marker;
      else if (line.trim() === "") cut = offset;
    } else if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = null;
    }
    offset += line.length + 1;
  }
  return { settled: text.slice(0, cut), tail: text.slice(cut) };
}

// A table is plain "| a | b |" text until its `|---|` row is complete, so a streaming head
// flashed as raw pipes and then jumped into a table. The trailing run of pipe lines waits until
// the row after the delimiter has started.
const DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function holdTableHead(tail: string): string {
  const lines = tail.split("\n");
  // A just-started line is still empty; it belongs to the run it follows
  const end = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
  let start = end;
  while (start > 0 && lines[start - 1].trimStart().startsWith("|")) start--;
  if (start === end) return tail;
  const delimiterDone = start + 2 < lines.length && DELIMITER_RE.test(lines[start + 1]);
  return delimiterDone ? tail : lines.slice(0, start).join("\n");
}
