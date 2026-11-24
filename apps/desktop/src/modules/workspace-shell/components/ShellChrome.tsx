"use client";

import Link from "next/link";
import { BrandWordmark } from "@/components/icons/BrandWordmark";
import { cn } from "@/lib/utils";
import type { ChatTabMark } from "@/modules/chat/domain/rail";
import { LumbonMark } from "@/modules/workspace-shell/components/LumbonMark";
import { UpdatePill } from "@/modules/lotus-settings/components/UpdatePill";
import type { ShellMode } from "@/modules/workspace-shell/types";

const MODES: { id: ShellMode; label: string }[] = [
  { id: "canvas", label: "Canvas" },
  { id: "code", label: "Code" },
  { id: "chat", label: "Chat" },
];

interface ShellChromeProps {
  mode: ShellMode;
  onModeChange: (mode: ShellMode) => void;
  onToggleRail?: () => void;
  /** Whether the rail is showing, so the toggle can say which way it will go. */
  railVisible?: boolean;
  /** macOS draws its window controls over the top-left; reserve the space when it does. */
  reserveTrafficLights?: boolean;
  status?: React.ReactNode;
  /** Chat threads that need you, drawn on the Chat tab while another mode is open. */
  chatMark?: ChatTabMark | null;
}

/**
 * The one title bar for Code and Chat.
 *
 * Canvas is reachable from here but does not live here: selecting it changes route and
 * CodeCanvas keeps its own chrome, exactly as it does today.
 */
export function ShellChrome({
  mode,
  onModeChange,
  onToggleRail,
  railVisible = true,
  reserveTrafficLights = false,
  status,
  chatMark,
}: ShellChromeProps) {
  // In Chat mode the rail already says all of this.
  const mark = mode === "chat" ? null : chatMark;
  return (
    <header className="ws-chrome" data-tauri-drag-region>
      <div className="ws-chrome-side" data-tauri-drag-region>
        {reserveTrafficLights ? <span className="ws-chrome-traffic-lights" aria-hidden /> : null}
        {/* The way out of this shell.
            Making `/` the unified shell removed every route to CodeSpace and the launcher: the
            old sidebar is hidden here, the mode switcher only reaches Canvas, and a Tauri window
            has no address bar — so the brand is the escape hatch until the shell hosts real
            panes itself. An anchor, not a button, so middle-click and ⌘-click still work. */}
        <Link href="/home" className="ws-brand" title="Open the launcher (CodeSpace, CodeChat, Canvas)">
          <BrandWordmark className="ws-brand-wordmark" />
        </Link>
        {onToggleRail ? (
          <button
            type="button"
            className="ws-chrome-button"
            onClick={onToggleRail}
            aria-label="Toggle rail"
            aria-expanded={railVisible}
            title={railVisible ? "Hide sidebar" : "Show sidebar"}
          >
            <svg
              className="ws-rail-glyph"
              data-open={railVisible ? "true" : "false"}
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path className="ws-rail-glyph-pane" d="M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
              <path d="M9 3v18" />
            </svg>
          </button>
        ) : null}
      </div>

      <div className="ws-chrome-side" data-align="center">
        {/*
          The switcher is one object with a thumb that travels, not three buttons that light up.

          That is the whole point of the redesign: `--ws-mode-index` is the only thing that
          changes on a switch, and the thumb slides to it. Every tab is the same width (flex
          basis 0), so the thumb's position is `index × 100%` of its own width — no measuring, no
          ResizeObserver, and nothing to get out of step when the window resizes.
        */}
        <div
          className="ws-mode-switcher"
          role="tablist"
          aria-label="Workspace mode"
          style={{ ["--ws-mode-index" as string]: String(Math.max(0, MODES.findIndex((item) => item.id === mode))) }}
        >
          <span className="ws-mode-thumb" aria-hidden />
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={mode === item.id}
              data-active={mode === item.id ? "true" : undefined}
              className={cn("ws-mode")}
              onClick={() => onModeChange(item.id)}
              title={item.id === "chat" && mark ? (mark.kind === "waiting" ? "A chat is waiting for you" : `${mark.count} chat${mark.count === 1 ? "" : "s"} ready`) : undefined}
              aria-label={item.id === "chat" && mark ? `Chat, ${mark.kind === "waiting" ? "waiting for you" : `${mark.count} ready`}` : undefined}
            >
              {item.label}
              {item.id === "chat" && mark ? (
                <span className="ws-mode-mark" data-kind={mark.kind} aria-hidden>
                  <LumbonMark tone={mark.kind} />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="ws-chrome-side" data-align="end" data-tauri-drag-region>
        {status}
        <UpdatePill />
      </div>
    </header>
  );
}
