"use client";

import { AtSign } from "lucide-react";

import { avatarHue, initials } from "../services/inbox-model";

/**
 * Who asked for a review, as a round monogram (`.pen` "Inbox review requests round 1", decision 2):
 * initials on a hue kept per Slack user id. No photo — that would need slack-edge in the CSP.
 * Someone Slack has no name for shows the @ glyph; the user themselves, a neutral disc.
 */
export function RequesterAvatar({ id, who, known, you, size = 20 }: { id: string | null | undefined; who: string; known: boolean; you: boolean; size?: number }) {
  return (
    <span
      className="au-avatar"
      data-hue={you || !known || !id ? "none" : avatarHue(id)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden
    >
      {known ? initials(who) : <AtSign size={Math.round(size * 0.5)} />}
    </span>
  );
}
