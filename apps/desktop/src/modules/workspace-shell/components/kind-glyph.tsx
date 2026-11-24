"use client";

import { FileCode, Globe, MessageSquare, SquareTerminal, type LucideIcon } from "lucide-react";
import type { PaneKind } from "@/modules/workspace-shell/types";

const KIND_ICONS: Record<PaneKind, LucideIcon> = {
  terminal: SquareTerminal,
  thread: MessageSquare,
  browser: Globe,
  editor: FileCode,
};

/**
 * The pane's kind, as a plain glyph.
 *
 * No tile behind it: a box per header adds a rectangle to every pane for information the title
 * already carries, and the rail is where kind is colour-coded. Here it stays monochrome.
 */
export function KindIcon({ kind, size = 16, className }: { kind: PaneKind; size?: number; className?: string }) {
  const Icon = KIND_ICONS[kind];
  return <Icon size={size} strokeWidth={1.75} className={className} />;
}
