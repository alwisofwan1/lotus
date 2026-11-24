import { stripAnsi } from "@/modules/codespace/services/terminal-status-lines";
import { splitPicks, withPicks, type Pick } from "@/modules/chat/domain/preview";

// Which agent pane a Code Browser pane talks to (plans/code-browser-redesign/PANE-LINK.md, option A).
// Pure: the pane, the agents on screen and what each printed in, the owner out.

/** An agent pane a Browser pane can send its picks to. */
export interface LinkAgent {
  id: string;
  name: string;
}

const LOOPBACK = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

/** How output may name `url`: a local server under any loopback name, anything else by its host. */
export function hostsOf(url: string): string[] {
  try {
    const { hostname, host, port } = new URL(url);
    return LOOPBACK.includes(hostname) && port ? LOOPBACK.map((name) => `${name}:${port}`) : host ? [host] : [];
  } catch {
    return [];
  }
}

/**
 * Who a Browser pane's picks go to: the agent it is linked to; unlinked, the agent whose output
 * names its address (it started that server). A link whose agent has closed gives nobody, so a pick
 * is never sent to a pane the person did not choose: the chip asks again.
 */
export function browserOwner(input: {
  linkedPaneId?: string;
  url: string;
  agents: readonly LinkAgent[];
  tail: (paneId: string) => string | null;
}): LinkAgent | null {
  if (input.linkedPaneId) return input.agents.find((agent) => agent.id === input.linkedPaneId) ?? null;
  const hosts = hostsOf(input.url);
  if (hosts.length === 0) return null;
  // Vite bolds the port (`localhost:\x1b[1m5173`), so the escapes go first.
  return input.agents.find((agent) => {
    const text = input.tail(agent.id);
    return text ? hosts.some((host) => stripAnsi(text).includes(host)) : false;
  }) ?? null;
}

/** The one-letter mark an agent wears on its header, its browsers' chips and the composer target. */
export function monogram(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/**
 * A message with the picks it carries, in Chat's `<picked-elements>` form (Chat panes draw it back
 * as chips). The element screenshots go by path, which Claude and Codex read as images. `oneLine`
 * for a terminal agent: a newline written to its TUI would send the message half-typed.
 */
export function withBrowserPicks(text: string, picks: readonly Pick[], oneLine: boolean): string {
  const paths = picks.flatMap((pick) => pick.attachments.map((attachment) => attachment.path));
  const body = paths.length > 0 ? `${text}\n\n(element screenshots: ${paths.join(" ")})`.trim() : text;
  const message = withPicks(body, picks);
  return oneLine ? message.replace(/\s*\n\s*/g, " ") : message;
}

/** What the person typed in a `withBrowserPicks` message: no picks, no screenshot paths. */
export function typedPart(message: string): string {
  return splitPicks(message).text.replace(/\s*\(element screenshots: [^)]*\)\s*$/, "").trim();
}

/** How an agent's header names its browser: a local server by its port, a site by its host. */
export function shortAddress(url: string): string {
  try {
    const { hostname, host, port } = new URL(url);
    return LOOPBACK.includes(hostname) && port ? `:${port}` : host || "page";
  } catch {
    return "page";
  }
}
