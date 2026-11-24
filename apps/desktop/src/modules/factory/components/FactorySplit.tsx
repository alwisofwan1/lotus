"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

/** The detail panel's width, per tab, as the user last left it; double-click the line for the default. */
export type FactorySplitTab = "runs" | "board" | "agents";

const DETAIL_DEFAULT: Record<FactorySplitTab, string> = { runs: "58%", board: "42%", agents: "42%" };
const LIST_MIN: Record<FactorySplitTab, string> = { runs: "260px", board: "320px", agents: "360px" };

/**
 * The list and the opened run side by side, with a line between them to drag, like a chat app's
 * thread panel. The detail keeps its width in pixels when the window changes; the list takes the
 * rest. With no run open, the list has the whole width.
 */
export function FactorySplit({
  tab,
  open,
  label = "Resize run detail",
  children,
}: {
  tab: FactorySplitTab;
  open: boolean;
  /** The drag line's name for a screen reader. */
  label?: string;
  children: [ReactNode, ReactNode];
}) {
  const [list, detail] = children;
  const layout = useDefaultLayout({ id: `factory-split-${tab}`, panelIds: open ? ["list", "detail"] : ["list"], storage: safeStorage });
  return (
    <Group
      key={tab}
      orientation="horizontal"
      className="fa-split"
      data-open={open ? "true" : undefined}
      data-tab={tab}
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <Panel id="list" minSize={LIST_MIN[tab]} className="fa-split-panel">
        {list}
      </Panel>
      {open ? (
        <>
          <Separator className="fa-resize" aria-label={label} />
          <Panel id="detail" defaultSize={DETAIL_DEFAULT[tab]} minSize="340px" maxSize="80%" groupResizeBehavior="preserve-pixel-size" className="fa-split-panel">
            {detail}
          </Panel>
        </>
      ) : null}
    </Group>
  );
}

/** localStorage when it works; a private window or blocked storage only loses the remembered width. */
const safeStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* the width is a convenience */
    }
  },
};

/** Esc closes the detail panel, unless focus is in a field: there Esc belongs to the field. */
export function useEscape(active: boolean, onEscape: () => void) {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
