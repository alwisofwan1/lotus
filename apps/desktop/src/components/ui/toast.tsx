"use client";
import type { ReactNode } from "react";

/** The bottom-right note: a dot, a line, an optional quiet line or action under it. */
const DOT = { ok: "bg-(--ui-ok)", warn: "bg-(--ui-warn)", err: "bg-(--ui-err)" } as const;

export function Toast({ title, detail, tone = "ok" }: { title: ReactNode; detail?: ReactNode; tone?: keyof typeof DOT }) {
  return (
    <div
      role="status"
      className="ui-dialog-in fixed bottom-4 right-4 z-[110] flex items-center gap-2.5 rounded-(--ui-r-lg) bg-(--ui-sheet) px-3 py-2.5 text-(--ui-ink) shadow-(--ui-card-shadow)"
    >
      <span className={`h-[7px] w-[7px] rounded-full ${DOT[tone]}`} aria-hidden />
      <span className="flex flex-col">
        <span className="ds-t-body">{title}</span>
        {detail ? <span className="ds-t-meta text-(--ui-ink-3)">{detail}</span> : null}
      </span>
    </div>
  );
}
