"use client";

import { useState } from "react";

import { ResourceTabs } from "@/components/resource/resource-kit";

import {
  parseReplyStyle,
  renderGroup,
  renderItem,
  renderReply,
  SAMPLE_LEAD,
  SAMPLE_REPLY_VALUES,
  SAMPLE_REPLY_VALUES_2,
} from "../services/reply-style";

/** The Slack reply's default shape, as the blocks the instructions may hold (crate `pr_review::reply_style`). */
export const REPLY_TEMPLATE =
  "```slack-reply\n{mention} {verdict} on {pr} · {counts}\n{points}\n```\n\n```slack-reply-lgtm\n{mention} LGTM ✅ {pr}\n```\n\n" +
  "```slack-reply-group\n{mention} Review selesai untuk {count} PR:\n\n{reviews}\n```";

/**
 * Under a PR review's instructions: the Slack reply is shaped by `slack-reply` blocks inside them,
 * which Lotus fills and the agent never reads. Offers the default shape to start from.
 */
export function ReplyStyleHint({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const has = value.includes("```slack-reply");
  return (
    <span className="au-hint au-reply-style-hint">
      Shape the Slack reply with a <code>```slack-reply</code> block (and <code>```slack-reply-lgtm</code> for an approval).
      Lotus fills <code>{"{mention} {verdict} {pr} {counts} {points} {title} {author} {lead}"}</code>; <code>{"{lead}"}</code> is
      the agent&apos;s own opening line for the round. A thread that asked for
      several PRs gets one message, shaped by <code>```slack-reply-group</code> with <code>{"{mention} {count} {reviews}"}</code>;
      each PR inside it by <code>```slack-reply-group-item</code> (and <code>```slack-reply-group-item-lgtm</code>).
      A PR asked again can have its own words: <code>```slack-reply-rereview</code>,{" "}
      <code>```slack-reply-rereview-lgtm</code> and <code>```slack-reply-group-rereview</code>. The reviewer never sees the
      blocks.{" "}
      {has ? null : (
        <button
          type="button"
          className="au-link"
          onClick={() => onChange(value.trim() ? `${value.trimEnd()}\n\n${REPLY_TEMPLATE}` : REPLY_TEMPLATE)}
        >
          Insert Slack reply template
        </button>
      )}
    </span>
  );
}

const PANELS = { review: "Review reply", lgtm: "LGTM reply", again: "Re-review reply", group: "Two-PR reply" } as const;

/**
 * What the Slack thread will be told, as the owner types: the reply filled with example values,
 * for a review with findings or for an approved one. A block Lotus would refuse on save says why
 * here first. Example values only: the real reply is filled by Lotus from the review at Send.
 */
export function SlackReplyPreview({ instructions }: { instructions: string }) {
  const [tab, setTab] = useState<keyof typeof PANELS>("review");
  const parsed = parseReplyStyle(instructions);
  return (
    <section className="au-reply-preview" aria-label="Slack reply preview">
      <div className="au-reply-preview-head">
        <span className="au-reply-preview-title">Slack reply preview</span>
        <ResourceTabs
          label="Reply kind"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "review", label: "Review" },
            { id: "lgtm", label: "LGTM" },
            { id: "again", label: "Re-review" },
            { id: "group", label: "2 PRs" },
          ]}
        />
      </div>
      {"error" in parsed ? (
        <p className="au-error" role="alert">
          {parsed.error}
        </p>
      ) : (
        <p className="au-reply-preview-text" role="tabpanel" aria-label={PANELS[tab]}>
          {tab === "group"
            ? renderGroup(parsed.style, SAMPLE_REPLY_VALUES.mention, [
                renderItem(parsed.style, false, SAMPLE_REPLY_VALUES),
                renderItem(parsed.style, true, SAMPLE_REPLY_VALUES_2),
              ])
            : tab === "again"
              ? renderReply(parsed.style, false, { ...SAMPLE_REPLY_VALUES, lead: SAMPLE_LEAD }, true)
              : renderReply(parsed.style, tab === "lgtm", SAMPLE_REPLY_VALUES)}
        </p>
      )}
      <span className="au-hint">Example values. Lotus fills the real ones from the review when you press Send.</span>
    </section>
  );
}
