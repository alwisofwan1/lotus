import type { Attachment } from "../domain/thread-event";

// Drag a file from the Files tab onto the composer (decision 15, mockups/chat-remote-attachments.html §5).
// Pointer events, not HTML5 drag: Tauri's file-drop handler swallows `dragover`/`drop` (see pane-drag.ts).
// The composer hears it as DOM events on its `[data-chat-file-drop]` element, so no page state carries it.

/** `detail`: true while the dragged file is over the target, false when it leaves. */
export const CHAT_FILE_OVER = "chat-file-over";
/** `detail`: the dropped Attachment. */
export const CHAT_FILE_DROP = "chat-file-drop";
/** Pointer travel before a press becomes a drag, so a plain click still opens the file. */
const SLOP_PX = 4;

export function beginFileDrag(
  down: { button: number; clientX: number; clientY: number; currentTarget: HTMLElement },
  file: Attachment,
): void {
  if (down.button !== 0) return;
  const source = down.currentTarget;
  let ghost: HTMLElement | null = null;
  let over: HTMLElement | null = null;

  const enter = (next: HTMLElement | null) => {
    if (next === over) return;
    over?.dispatchEvent(new CustomEvent(CHAT_FILE_OVER, { detail: false }));
    next?.dispatchEvent(new CustomEvent(CHAT_FILE_OVER, { detail: true }));
    over = next;
  };

  const move = (event: PointerEvent | MouseEvent) => {
    if (!ghost) {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < SLOP_PX) return;
      ghost = document.createElement("div");
      ghost.className = "chat-file-drag-chip";
      ghost.textContent = file.name;
      // Inside the chat, so the chip picks up its theme tokens.
      (source.closest(".chat-page") ?? document.body).appendChild(ghost);
    }
    ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 10}px)`;
    enter((document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-chat-file-drop]") ?? null);
  };

  const end = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", escape, true);
    const target = over;
    enter(null);
    if (!ghost) return;
    ghost.remove();
    // The release would also click the row it started on; a drag is not a click.
    const swallow = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (drop && target) target.dispatchEvent(new CustomEvent(CHAT_FILE_DROP, { detail: file }));
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
