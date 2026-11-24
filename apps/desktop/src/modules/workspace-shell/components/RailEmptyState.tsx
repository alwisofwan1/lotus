"use client";

import type { ReactNode } from "react";

/**
 * What an expanded folder with nothing running says.
 *
 * An empty expansion that renders nothing reads as a broken row — the folder looks like it
 * failed to open rather than like it has no work in it.
 */
export function RailEmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ws-rail-empty">
      <p>{children}</p>
      {action}
    </div>
  );
}
