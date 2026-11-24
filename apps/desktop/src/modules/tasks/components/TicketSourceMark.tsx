"use client";

import { BookOpen, Github } from "lucide-react";
import { ObsidianGlyph } from "@/modules/tasks/components/ObsidianGlyph";
import type { TicketSourceKind } from "@/modules/tasks/services/ticket-sources";

/**
 * The mark a ticket source wears — in the nav, and on a task's "From …" line.
 *
 * One place picks it, so a row or a backlink never draws the Obsidian crystal over a ticket that
 * came from somewhere else. Notion has no brand asset in the app, so it wears a plain book, as the
 * mockups do (`SOURCES 01`). GitHub wears lucide's GitHub mark.
 */
export function TicketSourceMark({ kind, size = 14 }: { kind: TicketSourceKind; size?: number }) {
  return (
    <span className="tk-vault-mark" aria-hidden data-source-kind={kind}>
      {kind === "obsidian" ? (
        <ObsidianGlyph size={size} decorative />
      ) : kind === "github" ? (
        <Github size={size} strokeWidth={1.75} aria-hidden />
      ) : (
        <BookOpen size={size} strokeWidth={1.75} aria-hidden />
      )}
    </span>
  );
}
