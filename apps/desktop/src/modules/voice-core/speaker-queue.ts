/**
 * **Speaker Queue** (ADR-0053, plans/voice-core stories 5–14) — the single owner of spoken output.
 *
 * - One utterance at a time. Waiting speech is ordered `reply` > `callout` > `narration`, oldest
 *   first within a priority. A newcomer never cuts the current utterance off, whatever its priority.
 * - **Live Voice** outranks everything through {@link SpeakerQueue.hold}: the current utterance stops
 *   at once (so it cannot leak into the Live Voice mic) and nothing else plays until
 *   {@link SpeakerQueue.release}. Callouts that arrive (or were cut off) meanwhile are kept; on
 *   release they play as ONE line — the original line for a single agent, else a summary naming up
 *   to three agents or giving a count. Held replies and narration are stale by then and dropped.
 *
 * Framework-free. The player is the only dependency; it must honour the abort signal.
 */

export type SpeakerPriority = "reply" | "callout" | "narration";

export interface SpeakerRequest {
  priority: SpeakerPriority;
  text: string;
  /** Language of the text (BCP-47 or bare code, e.g. "id"). */
  language?: string;
  /** Callouts: the agent that finished, for the post-Live Voice summary. */
  name?: string;
}

export interface SpeakerPlayer {
  /** Speak `text`; resolve when playback ends. Must stop promptly when `signal` aborts. */
  play(text: string, opts: { language?: string; signal: AbortSignal }): Promise<void>;
}

export interface SpeakerQueue {
  /** Queue speech. Resolves when it has been spoken, or when it was dropped or stopped. */
  enqueue(request: SpeakerRequest): Promise<void>;
  /** Silence everything: the current utterance and all waiting speech. */
  stopAll(): void;
  /** Silence one kind of speech (current utterance if it is that kind, plus its waiting items). */
  stop(priority: SpeakerPriority): void;
  /** Live Voice started: stop what is playing and keep everything else silent. */
  hold(): void;
  /** Live Voice ended: speak one callout line for what finished meanwhile; drop the rest. */
  release(): void;
  /** Whether Live Voice is holding every other voice right now. */
  isHeld(): boolean;
}

const RANK: Record<SpeakerPriority, number> = { reply: 0, callout: 1, narration: 2 };

/** Above this many agents the summary gives a count instead of names. */
const MAX_NAMED = 3;

interface Item extends SpeakerRequest {
  done: () => void;
}

export function createSpeakerQueue(player: SpeakerPlayer): SpeakerQueue {
  const waiting: Item[] = [];
  let current: { item: Item; controller: AbortController } | null = null;
  let held = false;
  let heldCallouts: SpeakerRequest[] = [];

  const pump = () => {
    if (current || held) return;
    const next = waiting.shift();
    if (!next) return;
    const controller = new AbortController();
    const playing = { item: next, controller };
    current = playing;
    void player
      .play(next.text, { language: next.language, signal: controller.signal })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.warn("[voice] speaker queue utterance failed:", error);
      })
      .finally(() => {
        if (current === playing) current = null;
        next.done();
        pump();
      });
  };

  const insert = (item: Item) => {
    const at = waiting.findIndex((w) => RANK[w.priority] > RANK[item.priority]);
    if (at === -1) waiting.push(item);
    else waiting.splice(at, 0, item);
  };

  const keepCallout = (request: SpeakerRequest) => {
    heldCallouts.push({ priority: request.priority, text: request.text, language: request.language, name: request.name });
  };

  const drop = (predicate: (item: Item) => boolean) => {
    for (let i = waiting.length - 1; i >= 0; i -= 1) {
      if (predicate(waiting[i])) waiting.splice(i, 1)[0].done();
    }
  };

  const abortCurrent = (predicate: (item: Item) => boolean = () => true): Item | null => {
    if (!current || !predicate(current.item)) return null;
    const { item, controller } = current;
    controller.abort();
    return item;
  };

  const enqueue = (request: SpeakerRequest): Promise<void> =>
    new Promise<void>((resolve) => {
      const item: Item = { ...request, done: resolve };
      if (held) {
        if (request.priority === "callout") keepCallout(request);
        resolve();
        return;
      }
      insert(item);
      pump();
    });

  return {
    enqueue,
    stopAll() {
      drop(() => true);
      abortCurrent();
    },
    stop(priority) {
      drop((item) => item.priority === priority);
      abortCurrent((item) => item.priority === priority);
    },
    hold() {
      if (held) return;
      held = true;
      for (const item of waiting) if (item.priority === "callout") keepCallout(item);
      drop(() => true);
      const cut = abortCurrent();
      if (cut?.priority === "callout") keepCallout(cut);
    },
    release() {
      if (!held) return;
      held = false;
      const callouts = heldCallouts;
      heldCallouts = [];
      if (callouts.length === 1) {
        void enqueue(callouts[0]);
      } else if (callouts.length > 1) {
        const language = callouts[callouts.length - 1].language;
        // One agent finishing twice is still one agent; an unnamed callout still counts as one.
        const names = [...new Set(callouts.map((c) => c.name).filter((n): n is string => !!n))];
        const unnamed = callouts.filter((c) => !c.name).length;
        void enqueue({ priority: "callout", text: calloutSummaryLine(names, language, names.length + unnamed), language });
      }
      pump();
    },
    isHeld: () => held,
  };
}

/** One short line for several finished agents: names when ≤3, else a count. English or Indonesian.
 *  `count` above `names.length` means some agents have no name — the count line then covers them all. */
export function calloutSummaryLine(names: readonly string[], language?: string, count = names.length): string {
  const indonesian = /^id\b/i.test(language ?? "");
  const total = Math.max(count, names.length);
  if (names.length === 0 || names.length > MAX_NAMED || total > names.length) return indonesian ? `${total} agen selesai.` : `${total} agents finished.`;
  const and = indonesian ? "dan" : "and";
  const list = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
  return indonesian ? `${list} selesai.` : `${list} finished.`;
}
