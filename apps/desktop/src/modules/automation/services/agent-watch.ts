import type { Automation } from "./automation-api";

/** The agent a host opened for "Describe it to an agent", as the Dock follows it (16e v2). */
export type WatchedAgent = { id: string; name: string };

/**
 * What a host that can show its agents offers the Dock's New page: open one with the request, fly
 * to it, close it, and say whether it is still there. Absent: the surface falls back to
 * `onCreateWithAgent` and hands the agent off, as before.
 */
export type AgentWatchHost = {
  create(prompt: string): Promise<WatchedAgent | { error: string }>;
  show(id: string): void;
  close(id: string): void;
  alive(id: string): boolean;
  /**
   * The agent is waiting on the person: a permission prompt, or a question it ended its turn on.
   * Its terminal can sit behind the Dock, so the Dock has to say so rather than "is working".
   */
  asking?(id: string): boolean;
  /** Fly to the agent and hand it the keyboard, stepping the Dock aside so it covers nothing. */
  answer?(id: string): void;
  /** The watch, kept by the host: the surface unmounts with a closed Dock and would lose it. */
  kept?: Watch | null;
  keep?(watch: Watch | null): void;
};

/** One request being watched: what was sent, to whom, and which automations existed before it. */
export type Watch = { request: string; agent: WatchedAgent; sentAtMs: number; before: string[] };

/**
 * "Saved" is the automation that appeared after this agent opened (ids before vs after), not any
 * change notification: another surface saving one at the same moment would otherwise count.
 */
export function savedBy(watch: Watch, automations: Automation[]): Automation | null {
  const before = new Set(watch.before);
  return automations.find((a) => !before.has(a.id)) ?? null;
}

export type WatchStep = { id: "opened" | "working" | "saved"; state: "done" | "active" | "todo" | "failed"; title: string; sub: string };

/** The three steps the app already knows; the next one is the only action. */
export function watchSteps(
  watch: Watch,
  { alive, saved, asking = false }: { alive: boolean; saved: Automation | null; asking?: boolean },
): WatchStep[] {
  const name = watch.agent.name;
  return [
    { id: "opened", state: "done", title: "Terminal opened", sub: `${name} · on this canvas, near the middle of your view` },
    saved
      ? { id: "working", state: "done", title: `${name} finished`, sub: "It saved what you asked for" }
      : alive && asking
        ? { id: "working", state: "active", title: `${name} is asking you`, sub: "It waits for your answer in its terminal" }
        : alive
        ? { id: "working", state: "active", title: `${name} is working`, sub: "It may ask you a question in the terminal" }
        : { id: "working", state: "failed", title: "Terminal closed", sub: "Nothing was saved. Describe it again to start over." },
    saved
      ? { id: "saved", state: "active", title: `${saved.name} · saved`, sub: saved.enabled ? "On" : "Switched off" }
      : { id: "saved", state: "todo", title: "Saved, switched off", sub: "You turn it on here when it is ready" },
  ];
}

/** "12s ago", "3m ago", "1h ago": how long since the request went. */
export function sentAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}
