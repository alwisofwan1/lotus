import { useEffect, type KeyboardEvent } from "react";

/**
 * Escape for a `<details>` menu.
 *
 * The browser does NOT close a `<details>` on Escape — that was assumed when these menus were
 * built, and it is only true of `<dialog>` and popovers. Left alone, the key fell through to the
 * tracker's own Escape and closed the whole panel with the menu still open inside it.
 *
 * `preventDefault` is the signal: the tracker's window listener steps back only for an Escape
 * nothing inside has already answered. Focus returns to the summary so the next key lands on the
 * control that was just closed, not on the page.
 */
export function closeDetailsOnEscape(event: KeyboardEvent<HTMLDetailsElement>): void {
  if (event.key !== "Escape") return;
  const details = event.currentTarget;
  if (!details.open) return;
  event.preventDefault();
  details.open = false;
  details.querySelector("summary")?.focus();
}

/**
 * Outside-click for every `<details data-menu>`: a press anywhere outside an open menu closes it.
 *
 * The browser does NOT do this either — a `<details>` closes only from its own summary. The menus
 * here were built believing otherwise, and a page with two of them (a ticket's Status and Assignee)
 * ended with both open, one drawn over the other. Found 2026-09-29 from a screenshot.
 *
 * One document listener for all of them, installed while any menu is mounted. It runs on
 * `pointerdown` in the capture phase, so pressing another menu's summary first closes this one:
 * one menu open at a time.
 */
let mounted = 0;

function closeOthers(event: Event) {
  const target = event.target as Node | null;
  for (const details of document.querySelectorAll<HTMLDetailsElement>("details[data-menu][open]")) {
    if (!target || !details.contains(target)) details.open = false;
  }
}

export function useCloseMenusOnOutsidePress(): void {
  useEffect(() => {
    if (mounted++ === 0) document.addEventListener("pointerdown", closeOthers, true);
    return () => {
      if (--mounted === 0) document.removeEventListener("pointerdown", closeOthers, true);
    };
  }, []);
}
