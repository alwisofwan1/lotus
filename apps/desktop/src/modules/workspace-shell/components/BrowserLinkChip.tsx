"use client";

// The agent a Code Browser pane sends its picks to (mockups/code-browser-pane.html, "Multi-pane").
// The menu is Chat's thread menu in shape; role="menu", so the native page steps aside under it.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus } from "lucide-react";

import { monogram, type LinkAgent } from "@/modules/workspace-shell/services/browser-link";

/** An agent's one-letter mark: on its browsers' chips, in the link menu, on the composer target. */
export function AgentMark({ name }: { name: string }) {
  return (
    <span className="ws-agent-mark" aria-hidden>
      {monogram(name)}
    </span>
  );
}

export function BrowserLinkChip({
  owner,
  agents,
  open,
  onOpenChange,
  onChoose,
  onHover,
}: {
  owner: LinkAgent | null;
  agents: readonly LinkAgent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (agentId: string) => void;
  /** The agent pane to outline beside this browser, or null to stop. */
  onHover: (agentId: string | null) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="ws-browser-link"
        data-none={owner ? undefined : ""}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={owner ? `Picks go to ${owner.name}. Change` : "Choose the agent picks go to"}
        title={owner ? `Picks go to ${owner.name} · click to change` : "Choose the agent this browser's picks go to"}
        onClick={() => onOpenChange(!open)}
        onMouseEnter={() => onHover(owner?.id ?? null)}
        onMouseLeave={() => onHover(null)}
      >
        {owner ? (
          <>
            <AgentMark name={owner.name} />
            <span className="ws-browser-link-name">{owner.name}</span>
            <ChevronDown className="ws-browser-link-caret" size={10} strokeWidth={2} aria-hidden />
          </>
        ) : (
          <>
            <Plus className="ws-browser-link-plus" size={12} strokeWidth={2} aria-hidden />
            <span className="ws-browser-link-name">Agent</span>
          </>
        )}
      </button>
      {open && anchor ? (
        <LinkMenu
          anchor={anchor}
          owner={owner}
          agents={agents}
          onHover={onHover}
          onChoose={(id) => {
            onChoose(id);
            onOpenChange(false);
          }}
          onClose={() => {
            onHover(null);
            onOpenChange(false);
          }}
        />
      ) : null}
    </>
  );
}

function LinkMenu({
  anchor,
  owner,
  agents,
  onHover,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement;
  owner: LinkAgent | null;
  agents: readonly LinkAgent[];
  onHover: (agentId: string | null) => void;
  onChoose: (agentId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    // Under the chip, right edges aligned, kept on screen.
    const a = anchor.getBoundingClientRect();
    const { width } = menu.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(a.right - width, innerWidth - width - 8)), y: a.bottom + 4 });
    (menu.querySelector<HTMLElement>("[aria-checked=true]") ?? menu.querySelector<HTMLElement>("[role^=menuitem]"))?.focus();
    const outside = (event: PointerEvent) => !menu.contains(event.target as Node) && !anchor.contains(event.target as Node) && onClose();
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [anchor, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)")];
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    const n = Number(event.key);
    if (event.key === "Escape" || event.key === "Tab") onClose();
    else if (event.key === "ArrowDown") buttons[(i + 1) % buttons.length]?.focus();
    else if (event.key === "ArrowUp") buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (n >= 1 && n <= agents.length) onChoose(agents[n - 1].id);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <div
      ref={ref}
      className="chat-thread-menu ws-browser-link-menu"
      role="menu"
      aria-label="Send picks to"
      style={pos ? { left: pos.x, top: pos.y } : { visibility: "hidden" }}
      onKeyDown={onKeyDown}
      onMouseLeave={() => onHover(null)}
    >
      <div className="chat-thread-menu-head">
        <span className="chat-thread-menu-sub">Send picks to</span>
      </div>
      {agents.length === 0 ? (
        <button type="button" role="menuitem" className="chat-thread-menu-item" disabled>
          No agent panes in this folder
        </button>
      ) : (
        agents.map((agent, index) => (
          <button
            key={agent.id}
            type="button"
            role="menuitemradio"
            aria-checked={agent.id === owner?.id}
            className="chat-thread-menu-item"
            onClick={() => onChoose(agent.id)}
            onMouseEnter={() => onHover(agent.id)}
            onFocus={() => onHover(agent.id)}
          >
            <AgentMark name={agent.name} />
            <span className="ws-browser-link-name">{agent.name}</span>
            <kbd>{agent.id === owner?.id ? "✓" : index < 9 ? index + 1 : ""}</kbd>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
