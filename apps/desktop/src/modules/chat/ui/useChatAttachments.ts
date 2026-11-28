"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { inspectTerminalFileDropPaths } from "@/lib/tauri/terminal-file-drop";
import { isTauri } from "@/lib/tauri/runtime";
import { formatShortcut } from "@/lib/hotkeys/format-shortcut";
import { listenWebviewDragDrop, safeTauriUnlisten, type TauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { dragDropHitTestPoints } from "@/modules/codespace/services/terminal-file-drop";

import { copyProgress, draftFromAttachment, draftFromPath, linkIsDown, MAX_PASTE_BYTES, remoteProblem, type DraftAttachment } from "../domain/attachments";
import type { Attachment } from "../domain/thread-event";
import { savePastedAttachment, uploadAttachment } from "../runtime/chat-runtime-client";

// What the composer and the start screen hold before a message goes (#279): picked, pasted and
// dropped files, and why one could not be added.

interface Options {
  /** Where pasted files are saved; any UUID before the thread exists. */
  threadId: string;
  /** An element inside the chat panel; a file dropped anywhere on the panel attaches. One small
   *  target made the overlay flash on and off as the drag crossed it. */
  anchor: RefObject<HTMLElement | null>;
  /** Set when nothing can be attached right now; adding shows it as the error. */
  refuse?: string | null;
  /** Return focus to the composer after an accepted native drop. */
  onDropAccepted?: () => void;
  /** A saved draft's attachments, read once on mount. */
  initial?: readonly Attachment[];
  /** The chat runs on another machine: `now` copies each file there as it is added, `on-send`
   *  leaves that to the send (a new chat has no thread to copy into yet). ADR-0069. */
  remote?: "now" | "on-send" | null;
}

/** How long a file waits before another try when the machine cannot be reached (decision 11). */
const RETRY_MS = 5000;

export function useChatAttachments({ threadId, anchor, refuse = null, onDropAccepted, initial, remote = null }: Options) {
  const [drafts, setDrafts] = useState<DraftAttachment[]>(() => (initial ?? []).map(draftFromAttachment));
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A restored draft can point at a file deleted since; its chip says so and sending waits for its removal.
  const [checkFirst] = useState(initial);
  useEffect(() => {
    if (!checkFirst?.length || !isTauri()) return;
    let cancelled = false;
    void Promise.all(
      checkFirst.map((a) => inspectTerminalFileDropPaths([a.path]).then(() => null, () => a.path)),
    ).then((gone) => {
      const missing = new Set(gone.filter((p): p is string => p !== null));
      if (cancelled || missing.size === 0) return;
      setDrafts((list) => list.map((d) => (missing.has(d.attachment.path) ? { ...d, problem: "File no longer exists · remove it" } : d)));
    });
    return () => {
      cancelled = true;
    };
  }, [checkFirst]);

  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  // Stable: `restore` is an effect dependency of its callers.
  const add = useCallback(
    (next: DraftAttachment[]) => {
      const checked = remote ? next.map((d) => ({ ...d, problem: d.problem ?? remoteProblem(d.attachment) })) : next;
      setDrafts((list) => [...list, ...checked.filter((d) => !list.some((x) => x.id === d.id))]);
    },
    [remote],
  );

  // Each file is copied to the chat's machine as it is added; sending waits for the copies.
  const copying = useRef(new Set<string>());
  const retries = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => retries.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (remote !== "now") return;
    const patch = (id: string, change: Partial<DraftAttachment>) =>
      setDrafts((list) => list.map((d) => (d.id === id ? { ...d, ...change } : d)));
    for (const d of drafts) {
      if (d.problem || d.attachment.remote !== undefined || copying.current.has(d.id)) continue;
      copying.current.add(d.id);
      if (!d.pending) patch(d.id, { pending: "Copying…", progress: 0 });
      const progress = (percent: number) => patch(d.id, { pending: `Copying ${percent}%`, progress: percent });
      uploadAttachment(threadId, d.attachment, progress).then(
        (attachment) => {
          copying.current.delete(d.id);
          patch(d.id, { attachment, pending: null, progress: null });
        },
        (reason: unknown) => {
          const why = reason instanceof Error ? reason.message : String(reason);
          if (!linkIsDown(why)) {
            copying.current.delete(d.id);
            return patch(d.id, { problem: why, pending: null, progress: null });
          }
          // shortcut: a fixed retry while the composer is open, not a link-up event; enough for one SSH link.
          patch(d.id, { pending: "Waiting for the machine…", progress: null });
          const retry = setTimeout(() => {
            retries.current.delete(retry);
            copying.current.delete(d.id);
            setDrafts((list) => [...list]);
          }, RETRY_MS);
          retries.current.add(retry);
        },
      );
    }
  }, [drafts, remote, threadId]);
  const restore = useCallback((attachments: readonly Attachment[]) => add(attachments.map(draftFromAttachment)), [add]);
  const allowed = () => {
    if (refuse) setError(refuse);
    return !refuse;
  };

  const attachPaths = async (paths: string[]) => {
    if (!allowed()) return;
    // A screenshot thumbnail or a picture dragged out of a browser can arrive as image data with no file.
    if (paths.length === 0) return setError(`That drop had no file to attach · paste it with ${formatShortcut("⌘V")}, or save it and drop the file`);
    setError(null);
    try {
      const inspected = await inspectTerminalFileDropPaths(paths);
      add(inspected.map(draftFromPath));
      return inspected.length > 0;
    } catch (reason) {
      report(reason);
    }
  };

  /** Pasted images and files have no path of their own; they are saved for the thread. */
  const paste = async (files: File[]) => {
    if (!allowed()) return;
    setError(null);
    const tooLarge = files.find((file) => file.size > MAX_PASTE_BYTES);
    if (tooLarge) return setError(`${tooLarge.name || "The pasted file"} is too large to paste · attach it with + instead`);
    try {
      add(await Promise.all(files.map(async (file) => draftFromAttachment(await savePastedAttachment(threadId, file)))));
    } catch (reason) {
      report(reason);
    }
  };

  const pick = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: true, directory: false, title: "Attach files" });
      if (picked !== null) await attachPaths(Array.isArray(picked) ? picked : [picked]);
    } catch (reason) {
      report(reason);
    }
  };

  // The drop listener lives for the component; refs give it the current props.
  const dropRef = useRef(attachPaths);
  dropRef.current = attachPaths;
  const onDropRef = useRef(onDropAccepted);
  onDropRef.current = onDropAccepted;

  // Tauri takes file drops natively, so the webview never sees them; hit-test the drop position.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: TauriUnlisten | undefined;
    let cancelled = false;
    let scale: Promise<number> | null = null;
    const inside = async (position: { x: number; y: number }): Promise<boolean> => {
      scale ??= import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow().scaleFactor().catch(() => window.devicePixelRatio || 1),
      );
      const points = dragDropHitTestPoints(position, await scale);
      const from = anchor.current;
      // A hidden mode, or a chat under the Tasks panel, is inert: the drop is not for it.
      if (!from || from.closest("[inert]")) return false;
      const page = from.closest<HTMLElement>(".chat-page");
      // Chat mode takes a drop anywhere on its surface, rail included; a chat in a Code pane only on itself.
      const area = (page?.hasAttribute("data-pane") ? page : from.closest<HTMLElement>(".ws-surface") ?? page) ?? from;
      const box = area.getBoundingClientRect();
      // The box, not elementFromPoint: a popover or a portal over the chat would otherwise turn a drop away.
      return points.some((p) => p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom);
    };
    // Every event is answered after an await; one answered late must not undo a later `leave`.
    let seq = 0;
    let lastDrag = 0;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const un = await listenWebviewDragDrop(getCurrentWebview(), async (event) => {
          const payload = event.payload;
          const mine = ++seq;
          lastDrag = Date.now();
          if (payload.type === "leave") return setDropping(false);
          const over = await inside(payload.position);
          if (payload.type === "drop") {
            setDropping(false);
            if (over && await dropRef.current(payload.paths)) onDropRef.current?.();
            return;
          }
          if (mine === seq) setDropping(over);
        });
        if (cancelled) safeTauriUnlisten(un);
        else unlisten = un;
      } catch {
        // Drop is a convenience; + and paste still attach.
      }
    })();
    // A drag cancelled with Esc, or dropped on another app, may never send `leave`. The pointer
    // moving over the page with no drag event for a moment means the drag is over.
    const settle = (event: Event) => {
      // A held button means the drag is still going, whatever WebKit reports in between.
      if (event instanceof PointerEvent && event.buttons !== 0) return;
      if (Date.now() - lastDrag > 200) setDropping(false);
    };
    window.addEventListener("pointermove", settle);
    window.addEventListener("blur", settle);
    return () => {
      cancelled = true;
      safeTauriUnlisten(unlisten);
      window.removeEventListener("pointermove", settle);
      window.removeEventListener("blur", settle);
    };
  }, [anchor]);

  return {
    drafts,
    attachments: drafts.map((d) => d.attachment),
    /** Some attachment cannot go; sending stays off until it is removed. */
    blocked: drafts.some((d) => d.problem),
    /** Still being copied to the chat's machine; sending waits. */
    copying: drafts.some((d) => d.pending),
    /** How far those copies are, 0–100; null when they cannot say. */
    progress: copyProgress(drafts),
    dropping,
    error,
    pick,
    paste,
    /** Puts back attachments of a message that could not be sent. */
    restore,
    remove: (id: string) => setDrafts((list) => list.filter((d) => d.id !== id)),
    clear: () => setDrafts([]),
  };
}

/** Files on the clipboard, unless it also has text: apps like Numbers put a picture of the
 *  selection beside its text, and the text wins. */
export function pastedFiles(data: DataTransfer | null): File[] {
  const files = Array.from(data?.files ?? []);
  return files.length > 0 && !data?.getData("text/plain") ? files : [];
}

