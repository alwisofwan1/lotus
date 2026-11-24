import { LAYOUT_BOUNDS } from "@/modules/workspace-shell/services/layout-preferences";
import { SPLIT_HANDLE_SIZE } from "@/modules/workspace-shell/services/split-sizing";

/**
 * How the three columns fit the room the host gives them. Automations is mounted in hosts of very
 * different widths — the whole Code column, a Chat column beside its rail, a Canvas side panel — so
 * it decides from its OWN measured width, never the window's.
 *
 * - `inline` / `inline`: sidebar | feed | pane, all side by side.
 * - pane `overlay`: no room for all three at their minimums; the pane slides over the feed when
 *   something is opened, and steps back to the list.
 * - nav `drawer`: not even sidebar + feed fit; the sidebar becomes a drawer opened from the header.
 *
 * - nav `host`: the host draws the sidebar in its own sidebar (the shell's rail), so only feed +
 *   pane share this width and the sidebar never becomes a drawer.
 *
 * A width of 0 is "not measured yet" (first paint, tests): everything inline, so nothing jumps.
 */

/** The feed is never squeezed below this; the panes give way first. */
export const FEED_MIN = 360;

export interface SurfaceFit {
  nav: "inline" | "drawer" | "host";
  pane: "inline" | "overlay";
}

const SEAM = SPLIT_HANDLE_SIZE;
/** Below this, sidebar + feed + pane cannot all sit at their minimums. */
export const PANE_OVERLAY_BELOW = LAYOUT_BOUNDS.automationNavWidth.min + FEED_MIN + LAYOUT_BOUNDS.automationPaneWidth.min + 2 * SEAM;
/** Below this, sidebar + feed cannot both sit at their minimums. */
export const NAV_DRAWER_BELOW = LAYOUT_BOUNDS.automationNavWidth.min + FEED_MIN + SEAM;

/** Below this, feed + pane cannot both sit at their minimums (the sidebar is the host's). */
export const HOSTED_PANE_OVERLAY_BELOW = FEED_MIN + LAYOUT_BOUNDS.automationPaneWidth.min + SEAM;

export function surfaceFit(width: number, { hostedNav = false }: { hostedNav?: boolean } = {}): SurfaceFit {
  if (hostedNav) return { nav: "host", pane: width > 0 && width < HOSTED_PANE_OVERLAY_BELOW ? "overlay" : "inline" };
  if (!(width > 0)) return { nav: "inline", pane: "inline" };
  return {
    nav: width < NAV_DRAWER_BELOW ? "drawer" : "inline",
    pane: width < PANE_OVERLAY_BELOW ? "overlay" : "inline",
  };
}
