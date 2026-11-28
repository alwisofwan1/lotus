"use client";

import { Check, Copy, MessageSquarePlus, TextQuote } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAriaKeyShortcuts, useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

/** The composer text for selected lines: a `path:L3-5` reference and the lines themselves. */
export function selectionMention(path: string, from: number, to: number, text: string): string {
  const fence = text.includes("```") ? "````" : "```";
  return `\`${path}:L${from}${to > from ? `-${to}` : ""}\`\n${fence}\n${text.replace(/\n+$/, "")}\n${fence}\n`;
}

interface Picked {
  from: number;
  to: number;
  /** `data-row` of each selected row, removed lines included; what a Review note gets. */
  rows: number[];
  text: string;
  /** The selection's box, in viewport pixels. */
  top: number;
  bottom: number;
  centre: number;
}

/** Pill height plus its gap to the selection; above it unless that leaves the window. */
const LIFT = 40;
const EDGE = 8;
/** How long a pressed action shows its ✓. Quote then lets go of the selection. */
const ADDED_MS = 420;
const COPIED_MS = 1200;

/**
 * A small toolbar above text selected inside `scope`: Quote (⌘L) and Copy.
 * - With a `path` (a diff or a file) rows carry `data-line`, and the selection goes in as a
 *   `path:L3-5` reference; line numbers and signs are `user-select: none`, so the text is the code.
 * - Without one (the chat's own replies) the plain text goes to `onAdd`, which makes a quote card.
 * Portaled: the Workbench's transform would otherwise anchor a fixed popover to the drawer.
 */
export function SelectionToChat({
  scope,
  path,
  onAdd,
  onReviewNote,
}: {
  scope: RefObject<HTMLElement | null>;
  path?: string;
  onAdd: (text: string) => void;
  /** A diff: starts a Review note on the selected rows. */
  onReviewNote?: (rows: number[]) => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [done, setDone] = useState<"add" | "copy" | null>(null);
  const shortcut = useFormatShortcut();
  const ariaShortcut = useAriaKeyShortcuts();
  const pickedRef = useRef(picked);
  const noteRef = useRef(onReviewNote);
  useEffect(() => {
    pickedRef.current = picked;
    noteRef.current = onReviewNote;
  });
  const canNote = !!onReviewNote;

  useEffect(() => {
    const onChange = () => {
      const selection = document.getSelection();
      const el = scope.current;
      if (!el || !selection || selection.isCollapsed || selection.rangeCount === 0) return setPicked(null);
      const range = selection.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return setPicked(null);
      const lines = Array.from(el.querySelectorAll<HTMLElement>("[data-line]"))
        .filter((row) => range.intersectsNode(row))
        .map((row) => Number(row.dataset.line))
        .filter((n) => n > 0);
      const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-row]"))
        .filter((row) => range.intersectsNode(row))
        .map((row) => Number(row.dataset.row));
      const text = selection.toString();
      // Removed lines carry no `data-line`: Add has nothing to cite, a Review note still can.
      if ((path !== undefined && lines.length === 0 && (!canNote || rows.length === 0)) || !text.trim()) return setPicked(null);
      const rect = range.getBoundingClientRect();
      setDone(null);
      setPicked({
        from: lines.length ? Math.min(...lines) : 0,
        to: lines.length ? Math.max(...lines) : 0,
        rows,
        text,
        top: rect.top,
        bottom: rect.bottom,
        centre: rect.left + rect.width / 2,
      });
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [scope, path, canNote]);

  useEffect(() => {
    if (done === null) return;
    const timer = setTimeout(() => {
      setDone(null);
      if (done === "add") {
        document.getSelection()?.removeAllRanges();
        setPicked(null);
      }
    }, done === "add" ? ADDED_MS : COPIED_MS);
    return () => clearTimeout(timer);
  }, [done]);

  const add = () => {
    const p = pickedRef.current;
    if (!p || (path !== undefined && p.from === 0)) return;
    onAdd(path === undefined ? p.text.trim() : selectionMention(path, p.from, p.to, p.text));
    setDone("add");
  };
  const note = () => {
    const p = pickedRef.current;
    if (!p || !noteRef.current) return;
    document.getSelection()?.removeAllRanges();
    setPicked(null);
    noteRef.current(p.rows);
  };
  const copy = () => {
    const p = pickedRef.current;
    if (p) void navigator.clipboard.writeText(p.text).then(() => setDone("copy"), () => {});
  };
  const addRef = useRef(add);
  useEffect(() => {
    addRef.current = add;
  });

  useEffect(() => {
    if (!picked) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        addRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked]);

  if (!picked) return null;
  const below = picked.top - LIFT < EDGE;
  const top = below ? Math.min(picked.bottom + EDGE, window.innerHeight - LIFT) : picked.top - LIFT;
  const left = Math.min(Math.max(picked.centre, 96), window.innerWidth - 96);
  const label = path === undefined ? "Quote" : "Add to chat";
  return createPortal(
    <div className="chat-selection-pop" role="toolbar" aria-label="Selection" data-below={below || undefined} style={{ left, top }}>
      {/* mousedown would clear the selection before the click lands */}
      {onReviewNote && picked.rows.length > 0 && (
        <button type="button" title="Review note on these lines" onMouseDown={(event) => event.preventDefault()} onClick={note}>
          <span className="chat-selection-glyph" aria-hidden>
            <MessageSquarePlus size={13} />
          </span>
          Review note
        </button>
      )}
      {(path === undefined || picked.from > 0) && <button type="button" aria-keyshortcuts={ariaShortcut("⌘L")} title={`${label}  ${shortcut("⌘L")}`} data-done={done === "add" || undefined} onMouseDown={(event) => event.preventDefault()} onClick={add}>
        <span className="chat-selection-glyph" aria-hidden>
          <TextQuote size={13} />
          <Check size={13} strokeWidth={2.4} />
        </span>
        {label}
      </button>}
      <button type="button" title={`Copy  ${shortcut("⌘C")}`} data-done={done === "copy" || undefined} onMouseDown={(event) => event.preventDefault()} onClick={copy}>
        <span className="chat-selection-glyph" aria-hidden>
          <Copy size={13} />
          <Check size={13} strokeWidth={2.4} />
        </span>
        {done === "copy" ? "Copied" : "Copy"}
      </button>
    </div>,
    document.body,
  );
}
