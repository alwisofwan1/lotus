/**
 * What waits for the user, and what does not: the one place every view counts and orders from.
 *
 * Pure on purpose. The sidebar badge, Inbox, a channel and any other host (Chat, Canvas) must agree
 * on what "waiting" means, so none of them derives it on its own.
 */

import type { Automation, AutomationDraft, AutomationRun } from "./automation-api";

/**
 * Automations whose latest finished run failed, with that run: Inbox's "Needs attention" cards and
 * the sidebar's red dot. A later success clears it; a skipped or still-running run says nothing.
 */
export function needsAttention(automations: Automation[], runs: AutomationRun[]): { automation: Automation; run: AutomationRun }[] {
  return automations.flatMap((automation) => {
    const run = runs
      .filter((r) => r.automationId === automation.id && (r.status === "failed" || r.status === "succeeded"))
      .sort((x, y) => y.createdAtMs - x.createdAtMs)[0];
    return run?.status === "failed" ? [{ automation, run }] : [];
  });
}

export const isAsk = (d: AutomationDraft) => d.kind === "ask" && Boolean(d.ask);

export function reviewRoomKey(d: AutomationDraft): string | null {
  return d.kind === "pr_review" && d.content ? `${d.automationId}:${d.content.repo.toLowerCase()}#${d.content.number}` : null;
}

/** Latest representative per PR; complete rounds stay accessible in the room's persisted history. */
export function latestReviewRounds(drafts: AutomationDraft[]): AutomationDraft[] {
  const seen = new Set<string>();
  return drafts.filter((d) => {
    const key = reviewRoomKey(d);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** A result for a channel is waiting on the user exactly like a review draft or an Ask is. */
export function waitsForYou(d: AutomationDraft): boolean {
  if (d.status !== "pending") return false;
  return d.kind === "pr_review" || isAsk(d) || Boolean(d.result?.channel);
}

/** A result that no longer needs the user: sent, or only ever for them. Kept as history. */
export function wasDelivered(r: AutomationDraft): boolean {
  return !waitsForYou(r) && r.status !== "discarded";
}

/** One plain line of agent text for a list row: no markdown marks, links reduced to their words. */
export function previewLine(text: string, max = 140): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** For each waiting result or Ask, when a newer one of the same automation also waits. */
export function newerRuns(waiting: AutomationDraft[]): Map<string, number> {
  const newer = new Map<string, number>();
  // Results supersede results and Asks supersede Asks (PLAN §8 Q6); a review is per PR.
  const group = (o: AutomationDraft) => (o.kind === "pr_review" ? null : isAsk(o) ? "ask" : "result");
  for (const d of waiting) {
    if (group(d) === null) continue;
    const later = waiting.filter((o) => group(o) === group(d) && o.automationId === d.automationId && o.createdAtMs > d.createdAtMs);
    if (later.length > 0) newer.set(d.id, Math.max(...later.map((o) => o.createdAtMs)));
  }
  return newer;
}


/**
 * Everything waiting, one row per PR (its latest round), Asks first — an Ask blocks an agent's
 * work — then newest first. A result that is also a draft is counted once.
 */
export function waitingItems(drafts: AutomationDraft[], results: AutomationDraft[]): AutomationDraft[] {
  const all = [...drafts.filter(waitsForYou), ...results.filter((r) => waitsForYou(r) && !drafts.some((d) => d.id === r.id))];
  return latestReviewRounds(all.sort((a, b) => Number(isAsk(b)) - Number(isAsk(a)) || b.createdAtMs - a.createdAtMs));
}

/** How many waiting rows each automation has, by id. */
export function pendingByAutomation(waiting: AutomationDraft[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of waiting) counts.set(d.automationId, (counts.get(d.automationId) ?? 0) + 1);
  return counts;
}

/**
 * A review's findings that still stand: new ones that ask for a change (blockers and should-fix;
 * questions and untagged notes do not), plus earlier ones a re-review found not fixed.
 */
export function openFindings(d: AutomationDraft): number {
  const c = d.content;
  if (!c) return 0;
  const fresh = c.comments.filter((x) => x.severity === "blocker" || x.severity === "should-fix").length;
  const earlier = (c.previous ?? []).filter((p) => p.status === "not-fixed").length;
  return fresh + earlier;
}

/** A re-review checks earlier findings; a first review has none to check. */
export const isReReview = (d: AutomationDraft) => (d.content?.previous?.length ?? 0) > 0;

/**
 * The heading a waiting row sits under. Asks lead, under their own heading (they block an agent);
 * the rest by day, newest first: "Today", "Yesterday", then "Mon 28 Sep".
 */
export function waitingGroupLabel(d: AutomationDraft, nowMs: number = Date.now()): string {
  if (isAsk(d)) return "Needs your answer";
  const day = (ms: number) => {
    const at = new Date(ms);
    return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  };
  const days = Math.round((day(nowMs) - day(d.createdAtMs)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(d.createdAtMs).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** The kind a quiet row's dot carries: violet answers, amber changes, grey waits. */
export type RowTone = "ask" | "changes" | "waiting";

/**
 * A waiting row's one status, in words, for the Dock's quiet list (`.pen` 16 v2, decision 4): one
 * line instead of a tag per fact. The tone picks the dot and the line's colour.
 */
export function rowStatus(
  d: AutomationDraft,
  { channelName = (id: string) => id, older = false }: { channelName?: (id: string) => string; older?: boolean } = {},
): { tone: RowTone; text: string } {
  const tail = older ? " · older run" : "";
  if (isAsk(d)) return { tone: "ask", text: `Needs your answer${tail}` };
  if (d.status === "sending") return { tone: "waiting", text: `Sending…${tail}` };
  if (d.kind === "pr_review" && d.content) {
    const n = d.content.comments.length;
    const comments = n > 0 ? ` · ${n} comment${n === 1 ? "" : "s"}` : "";
    const round = isReReview(d) ? "Re-review · " : "";
    const verdict = d.content.reply?.verdict;
    if (verdict === "changes-needed") return { tone: "changes", text: `${round}Changes needed${comments}${tail}` };
    if (verdict === "questions") return { tone: "changes", text: `${round}Questions${comments}${tail}` };
    return { tone: "waiting", text: `${round}Looks good${comments} · ready to send${tail}` };
  }
  const channel = d.result?.channel;
  return { tone: "waiting", text: `${channel ? `Waiting to post in #${channelName(channel)}` : "Waiting for you"}${tail}` };
}

/**
 * The Slack request a waiting PR review belongs to: its thread, as `channel:threadTs`. Null for
 * anything not asked for in Slack (Run now, a schedule, an Ask, a result).
 */
export function requestKey(d: AutomationDraft): string | null {
  return d.kind === "pr_review" && d.slack ? `${d.slack.channel}:${d.slack.threadTs}` : null;
}

/** One request in the waiting list: the PR reviews one Slack thread asked for, or a lone item. */
export type WaitingRequest = { key: string | null; items: AutomationDraft[] };

/**
 * The waiting list by request (`.pen` "Inbox review requests round 1", B): a Slack thread's PR
 * reviews sit together where its newest one would, in the order they were asked; everything else
 * stays a request of its own, in place.
 */
export function waitingRequests(waiting: AutomationDraft[]): WaitingRequest[] {
  const requests: WaitingRequest[] = [];
  const byKey = new Map<string, WaitingRequest>();
  for (const d of waiting) {
    const key = requestKey(d);
    const known = key ? byKey.get(key) : undefined;
    if (known) {
      known.items.push(d);
      continue;
    }
    const request = { key, items: [d] };
    requests.push(request);
    if (key) byKey.set(key, request);
  }
  for (const r of requests) r.items.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return requests;
}

/** `owner/repo#n` without the owner: every row of one request shares it, so it says nothing. */
export function shortPr(d: AutomationDraft): string {
  const c = d.content;
  return c ? `${c.repo.split("/").pop()}#${c.number}` : d.subject;
}

/** A PR row's one line: the Slack lead the reply opens with, else the review's own summary. */
export function reviewPreview(d: AutomationDraft, max?: number): string {
  return previewLine(d.content?.reply?.lead?.trim() || d.content?.summary || "", max);
}

/**
 * Who asked, in words. No requester is the user themselves: the trigger never records them as
 * their own requester (`slack/trigger.rs`). A requester Slack has no name for is "Someone" — the
 * raw `U…` id means nothing to a reader.
 */
export function requesterLabel(slack: AutomationDraft["slack"], names: ReadonlyMap<string, string>): { who: string; known: boolean; you: boolean } {
  const id = slack?.requester;
  if (!id) return { who: "You", known: true, you: true };
  const name = names.get(id);
  return name ? { who: name, known: true, you: false } : { who: "Someone", known: false, you: false };
}

/** Up to two initials for an avatar: "Tanaka" → "TA", "Rizky Pratama" → "RP". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return letters.toUpperCase();
}

/** A stable avatar hue (0–5) per Slack user id, so one person keeps one colour. */
export function avatarHue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}
