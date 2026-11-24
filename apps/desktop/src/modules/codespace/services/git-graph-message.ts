/** A commit message cut into plain text, commit hashes and GitHub `#N` references (Q18). */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "sha"; text: string }
  | { kind: "issue"; text: string; number: number };

// A hash is 7–40 hex with at least one digit and one letter: "deadbeef" in prose is rare,
// "1234567" is far more likely a number than a commit.
const TOKEN = /\b([0-9a-f]{7,40})\b|(?<![\w/])#(\d{1,7})\b/gi;

export function splitMessage(message: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let at = 0;
  for (const match of message.matchAll(TOKEN)) {
    const [whole, sha, issue] = match;
    const isSha = sha !== undefined && /\d/.test(sha) && /[a-f]/i.test(sha);
    if (!isSha && issue === undefined) continue;
    if (match.index > at) parts.push({ kind: "text", text: message.slice(at, match.index) });
    parts.push(isSha ? { kind: "sha", text: whole } : { kind: "issue", text: whole, number: Number(issue) });
    at = match.index + whole.length;
  }
  if (at < message.length) parts.push({ kind: "text", text: message.slice(at) });
  return parts;
}
