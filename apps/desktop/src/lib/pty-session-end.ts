/**
 * Native PTY exit notifications arrive as their own chunk (optionally CR/LF wrapped).
 * A truncated UTF-8 character can flush as U+FFFD immediately before the marker.
 * A marker quoted inside ordinary terminal output must never end the session.
 */
export function parsePtySessionEnd(data: string): number | null {
  const match = /^\uFFFD*[\r\n]*\[Session ended(?::(-?\d+))?\][\r\n]*$/.exec(data);
  return match ? Number(match[1] ?? 0) : null;
}
