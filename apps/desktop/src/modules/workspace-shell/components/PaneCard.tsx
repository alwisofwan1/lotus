"use client";

import { Maximize2, Minimize2, X } from "lucide-react";
import { createContext, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { KindIcon } from "@/modules/workspace-shell/components/kind-glyph";
import { paneActivityLabel } from "@/modules/workspace-shell/services/pane-activity";
import type { PaneActivity, PaneKind, PaneRunnerIdentity } from "@/modules/workspace-shell/types";

/**
 * A spot at the end of the pane's header, before Maximize and Close, where what the pane runs can
 * put its own control (a Chat pane's Done) with a portal. `display: contents`, so an empty slot
 * takes no room in the header's gap.
 */
export const PaneHeaderSlot = createContext<HTMLElement | null>(null);

interface PaneCardProps {
  /**
   * The pane this card draws, written into the DOM as `data-pane-id`.
   *
   * That attribute is how a keyboard move finds the element to put the cursor in: the shell's
   * panes are four components from three modules and only one of them exposes a focus method, so
   * the DOM is the one seam they all share. See `services/pane-focus-target.ts`.
   */
  paneId?: string;
  kind: PaneKind;
  title: string;
  meta: string;
  /**
   * The agent's handle, drawn as the NAME when it has one.
   *
   * Same order as CodeCanvas: mark, then who it is, then what it is doing. A pane that has a
   * persona is addressed by it, so it leads — and the generated title, which used to occupy this
   * slot alone, moves one step right into the sub-line instead of pushing the handle off screen.
   */
  persona?: string;
  /** Which CLI is behind it. Absent = no agent, and the kind glyph is the honest mark. */
  runner?: PaneRunnerIdentity;
  /**
   * What this pane is doing, drawn in its header.
   *
   * Absent draws nothing at all — a pane with no runner behind it (a browser, an editor) has no
   * state to report, and a badge saying "siap" over a web page would be noise pretending to be
   * information.
   */
  activity?: PaneActivity;
  /** When it entered that state. Unused since 07e dropped the badge; callers still pass it. */
  activitySince?: number;
  /**
   * The agent finished a turn and nobody has opened this pane since (`services/pane-unread.ts`).
   *
   * Drawn only while the pane is at rest. An ask or a failure is a separate state that outranks it,
   * and a pane already working on its next turn has moved past the result.
   */
  unread?: boolean;
  focused?: boolean;
  /** A maximized pane owns the grid; the others stay mounted but are taken out of view. */
  maximized?: boolean;
  /** Mounted, alive, and not on screen — focus mode hides its siblings this way. */
  hidden?: boolean;
  onFocus?: () => void;
  onClose?: () => void;
  onMaximize?: () => void;
  /** Right-click on the header: the pane's menu, as on its rail row. */
  onHeaderContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Set to let the header be dragged (onto a rail group); controls inside it never start a drag. */
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Set (to its workspace id) to let another pane's header be dropped here to swap the two. */
  swapWorkspaceId?: string;
  headerExtra?: ReactNode;
  /**
   * The conversation's title as a control (`ConversationTitle`): drawn after the handle when the
   * pane has one, as the name otherwise. Absent = the plain text this card always drew.
   */
  titleControl?: ReactNode;
  /** The agent's name as a control (`AgentNameControl`), drawn in place of the plain handle. */
  personaControl?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * The runner's silhouette, as a mask rather than as a picture.
 *
 * `currentColor` through a mask is what keeps a vendor logo from introducing a hue: the shell
 * spends colour on four things and none of them is a brand. Same technique as
 * `canvas-persona-badge`, so the two surfaces draw one agent with one shape.
 */
export function RunnerMark({ runner }: { runner: PaneRunnerIdentity }) {
  if (runner.mark.kind === "logo") {
    return (
      <span
        className="ws-pane-runner-mark"
        data-runner={runner.provider}
        style={{ "--ws-runner-logo": `url("${runner.mark.src}")` } as CSSProperties}
      />
    );
  }
  // No asset for this vendor. A dot in a ring says "an agent, not a shell" without borrowing
  // someone else's mark.
  return <span className="ws-pane-runner-mark" data-runner={runner.provider} data-generic="true" />;
}

/** The parts of the sub-line that still say something new, in reading order. */
function subLine(parts: Array<string | undefined>, name: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of parts) {
    const part = raw?.trim();
    // A part the NAME already carries is repetition, and repetition is what makes a header long.
    if (!part || part === name || seen.has(part)) continue;
    seen.add(part);
    kept.push(part);
  }
  return kept.join(" · ");
}

/**
 * One pane, whatever is inside it. A terminal, a thread, a browser and an editor get the same
 * chrome because the point of the merge is that they are peers.
 *
 * The header is ONE line, 34px tall since 07e (mockups/lotus-chat.fig, "07e Pane header"). It used to stack a title over a meta line at 42px, which
 * spent 168px of a four-pane window on chrome for two facts that fit side by side. What was
 * dropped is the stacking, not the information: everything the second line said is still here,
 * after the name, separated by a `·`.
 */
export function PaneCard({
  paneId,
  kind,
  title,
  meta,
  persona,
  runner,
  activity,
  unread,
  focused,
  maximized,
  hidden,
  onFocus,
  onClose,
  onMaximize,
  onHeaderContextMenu,
  onHeaderPointerDown,
  swapWorkspaceId,
  headerExtra,
  titleControl,
  personaControl,
  className,
  children,
}: PaneCardProps) {
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  // The handle leads when there is one; the generated title steps right rather than being replaced.
  const name = persona?.trim() || title;
  /*
    The strip carries WHO and WHAT, and nothing else.

    The folder and the launch command used to sit here too, and together they were the longest thing
    in the header and the least read: the folder is what the rail already groups by, and a flag list
    like `claude --dangerously-skip-permissions` is not something anybody scans a header for. They
    are still in `meta` and still one hover away, so this drops the NOISE rather than the fact.
  */
  const detail = subLine([persona ? title : undefined], name);
  /*
    Everything, for the hover — on BOTH spans, because a pane without a handle has no second span to
    hang it on and its shell would otherwise be unreachable from the header. `""` as the name turns
    off the "already said by the name" filter, since here the name is part of what is being said.
  */
  const hover = subLine([name, runner?.label, persona ? title : undefined, meta], "");
  const showsUnread = unread === true && (activity === "idle" || activity === "done");

  return (
    <section
      className={cn("ws-card ws-pane", className)}
      data-pane-id={paneId}
      data-pane-swap-ws={swapWorkspaceId}
      /* Focusable, but never a tab stop: the cursor is PUT here by a shortcut when the pane holds
         nothing to type into (a browser pane's page lives in a native webview), and adding panes to
         the natural tab order would put a stop between every field on the screen. */
      tabIndex={-1}
      data-kind={kind}
      data-activity={activity}
      data-focused={focused ? "true" : undefined}
      data-unread={showsUnread ? "true" : undefined}
      data-maximized={maximized ? "true" : undefined}
      data-hidden={hidden ? "true" : undefined}
      onFocusCapture={onFocus}
      onPointerDownCapture={onFocus}
      aria-label={title}
    >
      {/* The unread hairline. Always mounted so reading a result is a fade, not a cut. */}
      <span className="ws-pane-edge-light" aria-hidden />
      <header
        className="ws-pane-header"
        onContextMenu={onHeaderContextMenu}
        onPointerDown={
          onHeaderPointerDown &&
          ((event) => {
            // Controls inside the header keep their own press: close, maximise, the title field.
            if (!(event.target as HTMLElement).closest?.("button, input, textarea, a")) onHeaderPointerDown(event);
          })
        }
      >
        <span className="ws-pane-glyph" aria-hidden>
          {runner ? <RunnerMark runner={runner} /> : <KindIcon kind={kind} size={13} />}
        </span>
        <div className="ws-pane-heading ws-pane-heading--inline">
          {titleControl && !persona ? (
            <span className="ws-pane-title">{titleControl}</span>
          ) : (
            <span className="ws-pane-title" title={personaControl ? undefined : hover}>
              {persona && personaControl ? personaControl : name}
            </span>
          )}
          {titleControl && persona ? (
            <span className="ws-pane-meta">{titleControl}</span>
          ) : detail ? (
            <span className="ws-pane-meta" title={hover}>
              {detail}
            </span>
          ) : null}
        </div>
        {/*
          No badge (07e): the underline carries the state — it sweeps while working, turns violet
          when asking, gold for an unread result. The words stay for a screen reader.
        */}
        {showsUnread ? (
          <span className="sr-only">done · new</span>
        ) : activity ? (
          <span className="sr-only">{paneActivityLabel(activity)}</span>
        ) : null}
        {headerExtra}
        <span ref={setHeaderSlot} className="ws-pane-extra" />
        {/*
          Both controls are reserved space that only appears under the pointer or on the focused
          pane. Their 22px stays allocated so nothing reflows when they fade in — a header that
          changes width on hover is a header that makes the title jump.
        */}
        <button
          type="button"
          className="ws-chrome-button ws-pane-action"
          data-quiet="true"
          onClick={onMaximize}
          aria-label={maximized ? `Restore ${title}` : `Maximize ${title}`}
          title={maximized ? "Restore (Esc)" : "Maximize"}
        >
          {maximized ? <Minimize2 size={13} strokeWidth={1.75} /> : <Maximize2 size={13} strokeWidth={1.75} />}
        </button>
        <button
          type="button"
          className="ws-chrome-button ws-pane-action"
          data-quiet="true"
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          <X size={13} strokeWidth={1.75} />
        </button>
      </header>
      <div className="ws-pane-body">
        <PaneHeaderSlot.Provider value={headerSlot}>{children}</PaneHeaderSlot.Provider>
      </div>
    </section>
  );
}
