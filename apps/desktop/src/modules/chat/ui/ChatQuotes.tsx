"use client";

import { X } from "lucide-react";
import { useState } from "react";

import { reviewNoteRef, type Quote, type ReviewNote } from "../domain/quotes";

// A quote is a chip above the composer's
// input, not `> ` text in it; on send it becomes `> ` lines (domain/quotes.ts), and the sent bubble
// draws those lines back as quiet blocks.

export function QuoteCards({ quotes, armed, onRemove, onEdit }: { quotes: readonly Quote[]; armed?: string | null; onRemove: (id: string) => void; onEdit?: (id: string) => void }) {
  if (quotes.length === 0) return null;
  return (
    <ul className="chat-quotes" aria-label="Quoted">
      {quotes.map((q) => (
        <QuoteChip key={q.id} quote={q} armed={q.id === armed} onRemove={() => onRemove(q.id)} onEdit={q.review && onEdit ? () => onEdit(q.id) : undefined} />
      ))}
    </ul>
  );
}

function QuoteChip({ quote, armed, onRemove, onEdit }: { quote: Quote; armed: boolean; onRemove: () => void; onEdit?: () => void }) {
  const [leaving, setLeaving] = useState(false);
  return (
    <li
      className="chat-quote"
      data-armed={armed || undefined}
      data-leaving={leaving || undefined}
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) onRemove();
      }}
    >
      {quote.review ? (
        // A Review note: its reference and note; a click opens it in the diff.
        onEdit ? (
          <button type="button" className="chat-quote-review" title={`${quote.review.path} · edit review note`} onClick={onEdit}>
            <ReviewNoteLabel note={quote.review} />
          </button>
        ) : (
          <span className="chat-quote-review">
            <ReviewNoteLabel note={quote.review} />
          </span>
        )
      ) : (
        <span className="chat-quote-text">{quote.text}</span>
      )}
      <button
        type="button"
        className="chat-quote-x"
        aria-label="Remove quote"
        onClick={() => {
          if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) onRemove();
          else setLeaving(true);
        }}
      >
        <X size={10} strokeWidth={2.6} aria-hidden />
      </button>
    </li>
  );
}

/** The file's name, not its path: the card is narrow, and the title carries the path. */
function ReviewNoteLabel({ note }: { note: ReviewNote }) {
  return (
    <>
      <span className="chat-quote-ref">{reviewNoteRef({ ...note, path: note.path.slice(note.path.lastIndexOf("/") + 1) })}</span>
      <span className="chat-quote-note">{note.note}</span>
    </>
  );
}

/** The quotes at the head of a sent message, drawn as blocks inside its bubble. */
export function BubbleQuotes({ quotes }: { quotes: readonly string[] }) {
  return quotes.map((text, i) => (
    <blockquote key={i} className="chat-bubble-quote">
      {text}
    </blockquote>
  ));
}
