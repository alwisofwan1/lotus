/**
 * Drag a pane (a rail row or a pane's header) onto a rail group, with pointer events.
 *
 * Not HTML5 drag-and-drop: in the Tauri window the native file-drop handler swallows every
 * `dragover`/`drop`, so the page only ever saw `dragstart` and `dragend` (probed 2026-11-21).
 * Turning that handler off would break dropping files on a terminal.
 *
 * Nothing goes through React while the pointer moves: the ghost moves by `transform`, targets
 * are found by hit-testing `[data-pane-drop]` and lit with a `data-drop` attribute. React only
 * hears about the drop itself.
 *
 * A target is any element with `data-pane-drop` (a Frame id, or "loose" for the folder's loose
 * rows) and `data-pane-drop-ws` (its workspace id), or a pane on screen with `data-pane-id` and
 * `data-pane-swap-ws` (dropping there swaps the two panes, when the drag offers `onSwap`).
 */
export type PaneDrop = { kind: "move"; frameId: string } | { kind: "out" } | { kind: "swap"; paneId: string };

export const LOOSE_DROP = "loose";
/** Pointer travel before a press becomes a drag, so a plain click still clicks. */
const DRAG_SLOP_PX = 4;

export function beginPaneDrag(
  down: { button: number; clientX: number; clientY: number; pointerId: number; currentTarget: HTMLElement },
  pane: { label: string; paneId: string; workspaceId: string; fromFrameId: string | null; canSwap?: boolean; onDrop: (drop: PaneDrop) => void },
): void {
  if (down.button !== 0) return;
  const source = down.currentTarget;
  const startX = down.clientX;
  const startY = down.clientY;
  let ghost: HTMLElement | null = null;
  let lit: HTMLElement | null = null;

  const accepts = (target: HTMLElement) =>
    target.dataset.paneSwapWs !== undefined
      ? Boolean(pane.canSwap) && target.dataset.paneSwapWs === pane.workspaceId && target.dataset.paneId !== pane.paneId
      : target.dataset.paneDropWs === pane.workspaceId &&
    (target.dataset.paneDrop === LOOSE_DROP ? pane.fromFrameId !== null : target.dataset.paneDrop !== pane.fromFrameId);

  const light = (next: HTMLElement | null) => {
    if (next === lit) return;
    lit?.removeAttribute("data-drop");
    next?.setAttribute("data-drop", "true");
    lit = next;
  };

  const move = (event: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_SLOP_PX) return;
      ghost = document.createElement("div");
      ghost.className = "ws-pane-drag-chip";
      ghost.textContent = pane.label;
      // Inside the shell, so the chip picks up its theme tokens.
      (source.closest(".ws-shell") ?? document.body).appendChild(ghost);
      source.setAttribute("data-dragging", "true");
      document.documentElement.setAttribute("data-pane-dragging", "true");
    }
    ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 10}px)`;
    // The first target up the tree decides: a pane's own card must not fall through to "loose".
    const target = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-pane-drop], [data-pane-swap-ws]") ?? null;
    light(target && accepts(target) ? target : null);
  };

  const end = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", escape, true);
    const target = lit;
    light(null);
    if (!ghost) return;
    ghost.remove();
    source.removeAttribute("data-dragging");
    document.documentElement.removeAttribute("data-pane-dragging");
    // The release would also click the row it started on; a drag is not a click.
    const swallow = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (!drop || !target) return;
    if (target.dataset.paneSwapWs !== undefined) return pane.onDrop({ kind: "swap", paneId: target.dataset.paneId! });
    const frameId = target.dataset.paneDrop!;
    pane.onDrop(frameId === LOOSE_DROP ? { kind: "out" } : { kind: "move", frameId });
  };
  const up = () => end(true);
  const cancel = () => end(false);
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") end(false);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", escape, true);
}
