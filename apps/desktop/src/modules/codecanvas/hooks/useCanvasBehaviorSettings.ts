"use client";
import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_TOAST_POSITION,
  normalizeToastPosition,
  type ToastPosition,
} from "@/modules/codecanvas/services/agent-completion-toast";

// Canvas behaviour preferences — "how the canvas behaves" (the CNVS-style Canvas
// settings tab). Module-level useSyncExternalStore store, localStorage-backed,
// SSR-safe, mirroring useCanvasTheme. Every flag here gates a REAL behaviour
// (no placeholders — see the SETTINGS_SECTIONS contract in lotus-settings):
//   • allowAgentCanvasControl → MCP canvas-control bridge gate (useMcpCanvasControlBridge)
//   • allowAgentCanvasDraw  → MCP canvas-draw bridge gate (useMcpCanvasDrawBridge)
//   • autoFocusNewNodes     → command-center auto-focus on create (useCanvasCommandCenter)
//   • restoreViewportOnOpen → viewport restore effect (useCanvasViewportPersistence)
//   • tidyMode              → auto-arrange on single node open/close (canvas-tidy-trigger)
//   • canvasAnimations       → motion gate: data-canvas-motion shell attribute (motion.css)
//                              + every JS tween via canvasMotionEnabled() (canvas-motion.ts)
// Defaults preserve today's behaviour, so existing users see no change until they opt in/out.

const STORAGE_KEY = "canvas-behavior-settings-v1";
/**
 * Where the project/canvas controls (project switcher, Canvases, Settings) live.
 * "top-bar" is today's floating pill above the canvas; "command-bar" docks them into
 * the bottom NL command bar (CNVS-style), freeing the top edge for a full-bleed canvas.
 */
export type TopControlsPref = "top-bar" | "command-bar";
const VALID_TOP_CONTROLS: readonly TopControlsPref[] = ["top-bar", "command-bar"];

/**
 * How the bottom NL command bar looks at rest (before you engage it). "slab" is today's geometry —
 * a solid bar, everything visible all the time. "veil" is a bottom status strip on an edge-anchored
 * gradient that gathers into the same pill once you focus it or start talking. Both converge to an
 * identical solid pill on engagement; only the resting state differs. Internal names — the UI shows
 * "Solid bar" / "Bottom strip".
 */
export type CommandBarRestPref = "slab" | "veil";
const VALID_COMMAND_BAR_REST: readonly CommandBarRestPref[] = ["slab", "veil"];

/**
 * When the canvas re-tiles itself on a single node open/close. Replaces the old trio
 * tidyOnOpen / tidyOnClose / autoArrangeNotes (see {@link migrateTidyMode}).
 * "notes" tidies only when a note is added/removed; the others tidy notes too.
 */
export type TidyMode = "off" | "notes" | "open" | "open-close";
const VALID_TIDY_MODES: readonly TidyMode[] = ["off", "notes", "open", "open-close"];

/**
 * Map the three legacy booleans onto one mode, so existing users keep their behaviour.
 * shortcut: close-only (tidyOnClose without tidyOnOpen) has no option of its own and becomes "open-close"; upgrade if anyone asks.
 */
export function migrateTidyMode(old: { tidyOnOpen?: unknown; tidyOnClose?: unknown; autoArrangeNotes?: unknown }): TidyMode {
  const open = typeof old.tidyOnOpen === "boolean" ? old.tidyOnOpen : true;
  const close = typeof old.tidyOnClose === "boolean" ? old.tidyOnClose : false;
  const notes = typeof old.autoArrangeNotes === "boolean" ? old.autoArrangeNotes : true;
  if (close) return "open-close";
  if (open) return "open";
  return notes ? "notes" : "off";
}

export interface CanvasBehaviorSettings {
  /** Allow agents (via MCP) to pan/zoom/focus and auto-arrange the canvas. Off = agent canvas-control requests are denied; your own mouse/voice are never affected. */
  allowAgentCanvasControl: boolean;
  /** Allow agents (via MCP) to draw shapes and generate diagrams on the canvas. Off = agent draw requests are denied; distinct from canvas-control because drawing mutates board content, not just the camera. */
  allowAgentCanvasDraw: boolean;
  /** Pan/zoom to a node when it's created by the command bar or an agent. */
  autoFocusNewNodes: boolean;
  /** Restore the saved pan/zoom when a project is opened. */
  restoreViewportOnOpen: boolean;
  /** When a single node open/close re-tiles the canvas into a grid. */
  tidyMode: TidyMode;
  /** Smooth canvas animations: node enter/close, status crossfades, camera glides. Off = everything instant (also honored when the OS asks for reduced motion). */
  canvasAnimations: boolean;
  /**
   * Show the left-edge whiteboard tool rail (CanvasToolRail).
   *
   * Off hides the rail AND its drawing shortcuts (R/O/D/T/A/L/P/E) — an armed drawing tool with no
   * rail on screen has nothing to explain itself. The navigation shortcuts V (select) and H (pan)
   * keep working, because the rail is the only click path to a tool and without them `activeTool`
   * would be pinned to "select" for the whole session, which leaves the canvas unpannable by left
   * drag. See resolveToolShortcut in services/canvas-tool.ts for the full reasoning.
   */
  showToolRail: boolean;
  /** Where the project/canvas controls live: their own top pill, or docked in the bottom command bar. */
  topControls: TopControlsPref;
  /**
   * How the bottom NL command bar looks before you engage it. "slab" (default) is a solid bar, always
   * fully visible. "veil" trims it to a bottom status strip on a gradient that gathers into the same
   * solid pill the moment you focus it or start talking — quieter at rest, identical once engaged.
   */
  commandBarRest: CommandBarRestPref;
  /**
   * Shift+Enter in a canvas Terminal node sends Meta+Enter (ESC CR) instead of a plain Enter —
   * newline-insert in zsh and Claude Code, a no-op in bash. Off = Shift+Enter submits like Enter
   * (matters in vim, where ESC CR exits insert mode). Agent nodes always translate Shift+Enter
   * regardless of this flag, since their PTY child is a known agent CLI.
   */
  terminalShiftEnterNewline: boolean;
  /** Where the "agent finished" completion toasts anchor on the canvas. Default bottom-right. */
  toastPosition: ToastPosition;
  /** Auto-dismiss agent completion toasts after their adaptive foreground/background duration. */
  completionToastAutoDismiss: boolean;
  /**
   * Auto-close the realtime Live Voice session shortly after each command completes and you fall
   * silent. On (default) keeps it snappy — say one thing, it acts, then the mic closes. Off keeps the
   * session open for back-to-back commands; it still closes on an explicit sign-off, long inactivity,
   * or the 20-minute cap.
   */
  voiceAutoCloseAfterCommand: boolean;
  /**
   * Auto-open a Browser Node when a canvas Terminal's dev server prints its localhost URL
   * (Vite/Next/CRA/…), so "run the app" surfaces the running app on the canvas without a manual
   * open — mirrors the iOS Simulator pane. Opens once per (terminal, origin); navigates the paired
   * browser if one already exists. Default on.
   */
  autoOpenBrowserOnDevServer: boolean;
  /**
   * Narrate agent work aloud as it happens — tool calls, failures, turn ends — instead of only
   * announcing when an agent finishes. Off by default: with a single agent the router speaks every
   * tool call, which is a lot of talking to opt somebody into without asking.
   */
  liveNarration: boolean;
}

export const DEFAULT_CANVAS_BEHAVIOR: CanvasBehaviorSettings = {
  liveNarration: false,
  allowAgentCanvasControl: false,
  allowAgentCanvasDraw: false,
  autoFocusNewNodes: true,
  restoreViewportOnOpen: true,
  tidyMode: "open",
  canvasAnimations: true,
  showToolRail: true,
  topControls: "top-bar",
  commandBarRest: "slab",
  terminalShiftEnterNewline: true,
  toastPosition: DEFAULT_TOAST_POSITION,
  completionToastAutoDismiss: true,
  voiceAutoCloseAfterCommand: true,
  autoOpenBrowserOnDevServer: true,
};

let state: CanvasBehaviorSettings = DEFAULT_CANVAS_BEHAVIOR;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function load(): CanvasBehaviorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CANVAS_BEHAVIOR;
    const parsed = JSON.parse(raw) as Partial<CanvasBehaviorSettings>;
    // Merge each known flag over its default so a newly-added flag (or a missing
    // one) picks up its default instead of `undefined`, and unknown keys are dropped.
    const next = { ...DEFAULT_CANVAS_BEHAVIOR };
    for (const key of Object.keys(DEFAULT_CANVAS_BEHAVIOR) as (keyof CanvasBehaviorSettings)[]) {
      if (key === "tidyMode") {
        const value = parsed.tidyMode;
        next.tidyMode =
          typeof value === "string" && (VALID_TIDY_MODES as readonly string[]).includes(value)
            ? (value as TidyMode)
            : migrateTidyMode(parsed as Record<string, unknown>);
      } else if (key === "topControls") {
        const value = parsed.topControls;
        if (typeof value === "string" && (VALID_TOP_CONTROLS as readonly string[]).includes(value)) {
          next.topControls = value as TopControlsPref;
        }
      } else if (key === "commandBarRest") {
        const value = parsed.commandBarRest;
        if (typeof value === "string" && (VALID_COMMAND_BAR_REST as readonly string[]).includes(value)) {
          next.commandBarRest = value as CommandBarRestPref;
        }
      } else if (key === "toastPosition") {
        // Coerce any legacy/tampered value back to a supported position.
        next.toastPosition = normalizeToastPosition(parsed.toastPosition);
      } else if (typeof parsed[key] === "boolean") {
        (next as Record<string, unknown>)[key] = parsed[key];
      }
    }
    return next;
  } catch {
    return DEFAULT_CANVAS_BEHAVIOR;
  }
}

function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  const next = load();
  if (next !== state) {
    state = next;
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  hydrateOnce();
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): CanvasBehaviorSettings => state;
const getServerSnapshot = (): CanvasBehaviorSettings => DEFAULT_CANVAS_BEHAVIOR;

/**
 * Synchronous read for non-React callers (e.g. the command-center callback and
 * the viewport effect). Hydrates on first access so a fresh page load reads the
 * persisted value rather than the default.
 */
export function getCanvasBehaviorSettings(): CanvasBehaviorSettings {
  hydrateOnce();
  return state;
}

export function setCanvasBehaviorSetting<K extends keyof CanvasBehaviorSettings>(
  key: K,
  value: CanvasBehaviorSettings[K],
) {
  hydrateOnce();
  if (state[key] === value) return;
  state = { ...state, [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
  emit();
}


/** Test-only: reset the shared store so suites don't leak state into each other. */
export function resetCanvasBehaviorStoreForTests() {
  state = DEFAULT_CANVAS_BEHAVIOR;
  hydrated = false;
  listeners.clear();
}

export function useCanvasBehaviorSettings(): CanvasBehaviorSettings & {
  setBehavior: <K extends keyof CanvasBehaviorSettings>(key: K, value: CanvasBehaviorSettings[K]) => void;
} {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setBehavior = useCallback(
    <K extends keyof CanvasBehaviorSettings>(key: K, value: CanvasBehaviorSettings[K]) =>
      setCanvasBehaviorSetting(key, value),
    [],
  );
  return { ...settings, setBehavior };
}
