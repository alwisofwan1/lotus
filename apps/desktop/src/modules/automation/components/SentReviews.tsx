"use client";

import { Check, ExternalLink } from "lucide-react";

import { SlackMark } from "@/components/icons/ServiceMarks";

import type { AutomationClient, AutomationDraft } from "../services/automation-api";
import { repliedThreads, slackWaiting, SlackOutcome } from "./DraftCard";
import { ReviewRoom } from "./ReviewRoom";
import { formatWhen } from "../services/format";

/**
 * Reviews already on GitHub. One line each: which PR, when, and what happened in Slack, so a
 * review that left no trace in its thread says so here instead of vanishing with its card.
 */
export function SentReviews({ sent, channelName, client, running }: { sent: AutomationDraft[]; channelName: (id: string) => string; client?: AutomationClient; running?: (d: AutomationDraft) => boolean }) {
  return (
    <ul className="au-sent-list" aria-label="Sent reviews">
      {sent.map((d) => {
        const comments = d.content?.comments.length ?? 0;
        return (
          <li key={d.id} className="au-sent-row">
            <Check size={13} className="au-dest-ok" aria-label="Sent" />
            <a className="au-sent-subject" href={d.sentUrl ?? d.content?.url} target="_blank" rel="noreferrer" title="View the review on GitHub">
              {d.subject}
              <ExternalLink size={11} aria-hidden />
            </a>
            <span className="au-sent-meta">
              {comments} comment{comments === 1 ? "" : "s"} · {formatWhen(d.sentAtMs ?? d.createdAtMs)}
            </span>
            <span className="au-sent-slack">
              <SlackState draft={d} channelName={channelName} client={client} />
            </span>
            {client ? <ReviewRoom draft={d} client={client} running={running?.(d)} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function SlackState({ draft, channelName, client }: { draft: AutomationDraft; channelName: (id: string) => string; client?: AutomationClient }) {
  const reply = draft.slackReply;
  // Held for the thread's other reviews: says so, with Reply now.
  if (reply && slackWaiting(reply)) return <SlackOutcome key={reply} reply={reply} draftId={draft.id} client={client} />;
  const threads = repliedThreads(reply);
  if (threads && draft.slack) {
    const more = threads - 1;
    return (
      <span className="au-note">
        <SlackMark size={10} /> Replied in #{channelName(draft.slack.channel)}
        {more > 0 ? ` and ${more} more thread${more === 1 ? "" : "s"}` : ""}
      </span>
    );
  }
  if (reply) {
    return (
      <span className="au-error" title={reply}>
        <SlackMark size={10} /> {reply.replace(/^not replied: /, "Not replied: ")}
      </span>
    );
  }
  return <span className="au-hint">{draft.slack ? "No Slack reply (unticked)" : "Not from Slack"}</span>;
}
