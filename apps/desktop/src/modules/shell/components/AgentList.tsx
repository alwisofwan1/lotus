"use client";

import { useCallback, useState } from "react";
import { CLI_TINTS, CliLogo } from "@/modules/lotus-settings/components/CliLogo";
import type { RunningAgent } from "@/modules/shell/services/quit-agents";

/** The last two path segments: enough to tell two checkouts apart. */
function project(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

/** Fades the edge of the list that still has rows, in place of a scrollbar. */
const EDGE_FADE = {
  down: "linear-gradient(#000 calc(100% - 28px), transparent)",
  up: "linear-gradient(transparent, #000 28px)",
  both: "linear-gradient(transparent, #000 28px, #000 calc(100% - 28px), transparent)",
} as const;

/** Running agents as logo, name, project and a live dot; shared by the quit dialogs. */
export function AgentList({ agents }: { agents: RunningAgent[] }) {
  const [edge, setEdge] = useState<keyof typeof EDGE_FADE | null>(null);

  const listRef = useCallback((list: HTMLUListElement | null) => {
    if (!list) return;
    const measure = () => {
      const up = list.scrollTop > 2;
      const down = list.scrollTop + list.clientHeight < list.scrollHeight - 2;
      setEdge(up && down ? "both" : up ? "up" : down ? "down" : null);
    };
    measure();
    list.onscroll = measure;
  }, []);

  const fade = edge ? EDGE_FADE[edge] : undefined;

  return (
    <ul
      ref={listRef}
      className="mt-4 max-h-[180px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
    >
      {agents.map((a, i) => (
        <li key={i} className="flex h-9 items-center gap-2.5" title={a.cwd || undefined}>
          <CliLogo id={a.agent} size={16} tint={CLI_TINTS[a.agent]} />
          <span className="font-medium">{a.agent}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-(--ui-ink-4)">{project(a.cwd)}</span>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--ui-ok)" aria-hidden />
        </li>
      ))}
    </ul>
  );
}
