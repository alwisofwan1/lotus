import type { CanvasBrowserState } from "../types/canvas";
import { isBlankCanvasBrowserUrl } from "../runtime/adapters/canvas-browser-lifecycle-adapter";

export interface CanvasBrowserRecoveryInput {
  /** The node's in-memory lifecycle claim. */
  browserState: CanvasBrowserState;
  /** Native view is parked on purpose (drag/resize gesture, blocking overlay, or LOD collapse). */
  suspended: boolean;
  /** URL the node believes it is live on. */
  url: string;
  /** Whether the native child WebView actually exists right now (probed out of band). */
  webviewOpen: boolean;
}

/**
 * Decide whether a browser node must self-heal its native WebView.
 *
 * A node claiming "active" while its native child WebView is absent renders a
 * black pane under a live green dot: the WebView was torn down (a crash, a
 * park-at-open that never re-synced, or a teardown the one-shot mount-recovery
 * path did not cover) but the in-memory "active" claim survived. The React tree
 * cannot see into the OS-level native surface, so existence is probed out of
 * band and recovery fires only when the claim is genuinely unfulfilled — never
 * while the view is legitimately parked or has no page to be live on.
 */
export function shouldRecoverCanvasBrowser(input: CanvasBrowserRecoveryInput): boolean {
  if (input.browserState !== "active") return false;
  if (input.suspended) return false;
  if (isBlankCanvasBrowserUrl(input.url)) return false;
  return !input.webviewOpen;
}

/** What repair, if any, an active browser node needs to stop rendering a black pane. */
export type CanvasBrowserRepair = "none" | "reopen" | "resync-bounds";

export interface CanvasBrowserRepairInput {
  /** The node's in-memory lifecycle claim. */
  browserState: CanvasBrowserState;
  /** Native view is parked on purpose (drag/resize gesture, blocking overlay, or LOD collapse). */
  suspended: boolean;
  /** URL the node believes it is live on. */
  url: string;
  /** Whether the native child WebView exists right now (probed out of band). */
  open: boolean;
  /**
   * Whether the existing native WebView is sitting at (or near) PARKED_BOUNDS —
   * off-screen and ~1px — probed out of band. Meaningless when `open` is false.
   */
  viewportParked: boolean;
}

/**
 * Decide how to repair a black pane, distinguishing the two failure classes the
 * boolean {@link shouldRecoverCanvasBrowser} could not tell apart:
 *
 * - **WebView absent** (`open: false`) → `"reopen"`: re-open the page. This is
 *   the original teardown-without-remount black pane.
 * - **WebView open but parked** (`open: true, viewportParked: true`) → the
 *   recurrence: the surface exists but sits at PARKED_BOUNDS behind a live green
 *   dot (a failed/lost unpark, a park-at-open that never re-synced, or an
 *   external-park desync). Existence-only recovery is blind to this because the
 *   WebView *does* exist. The repair is to re-push live bounds (`"resync-bounds"`),
 *   never a re-open — re-opening would reload a live page out from under the user.
 *
 * Repairs are gated exactly like recovery: only for an `active` node, never while
 * legitimately suspended (a real park is *supposed* to be parked) or blank.
 */
export function decideCanvasBrowserRepair(input: CanvasBrowserRepairInput): CanvasBrowserRepair {
  if (input.browserState !== "active") return "none";
  if (input.suspended) return "none";
  if (isBlankCanvasBrowserUrl(input.url)) return "none";
  if (!input.open) return "reopen";
  if (input.viewportParked) return "resync-bounds";
  return "none";
}
