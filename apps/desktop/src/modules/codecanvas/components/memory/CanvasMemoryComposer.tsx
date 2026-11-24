"use client";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  MEMORY_COMPOSE_KINDS,
  describeMemoryKind,
} from "../../services/memory/codecanvas-memory-presentation";

export interface MemoryDraft {
  kind: string;
  body: string;
  title?: string;
  tags?: string[];
}

interface Props {
  open: boolean;
  /** Kind the composer opens on, so the empty state can seed "write the first rule". */
  initialKind?: string;
  onOpen: (kind?: string) => void;
  onCancel: () => void;
  onSubmit: (draft: MemoryDraft) => void;
}

function parseTags(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((tag) => tag.replace(/^#/, "").trim())
    .filter(Boolean);
}

/**
 * Collapsed by default: the panel is a reading surface first. Kind is a chip row rather than a native
 * select, and the hint states whether the draft will reach agents before it is saved — `note` never
 * does, which the old dropdown never said.
 */
export function CanvasMemoryComposer({ open, initialKind, onOpen, onCancel, onSubmit }: Props) {
  const [kind, setKind] = useState<string>(initialKind ?? MEMORY_COMPOSE_KINDS[0]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // The panel remounts this component when it seeds a different kind, so `kind` needs no sync effect.
  useEffect(() => {
    if (open) bodyRef.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <button type="button" className="canvas-memory-add" onClick={() => onOpen()}>
        <Plus size={13} aria-hidden />
        Add memory
        <span className="canvas-memory-kbd">⌘⏎</span>
      </button>
    );
  }

  const presentation = describeMemoryKind(kind);

  const submit = () => {
    const trimmedBody = body.trim();
    if (!trimmedBody) return;
    const trimmedTitle = title.trim();
    const parsedTags = parseTags(tags);
    onSubmit({
      kind,
      body: trimmedBody,
      ...(trimmedTitle ? { title: trimmedTitle } : {}),
      ...(parsedTags.length > 0 ? { tags: parsedTags } : {}),
    });
    setTitle("");
    setBody("");
    setTags("");
  };

  return (
    <form
      className="canvas-memory-compose"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="canvas-memory-compose-kinds" role="group" aria-label="Memory kind">
        {MEMORY_COMPOSE_KINDS.map((option) => {
          const kindPresentation = describeMemoryKind(option);
          return (
            <button
              key={option}
              type="button"
              className="canvas-memory-chip"
              aria-pressed={option === kind}
              onClick={() => setKind(option)}
            >
              <span className="canvas-memory-glyph" aria-hidden>{kindPresentation.glyph}</span>
              {kindPresentation.label}
            </button>
          );
        })}
      </div>

      <p className="canvas-memory-compose-hint" data-testid="canvas-memory-compose-hint">
        <b>{presentation.label}.</b> {presentation.blurb}
      </p>

      <div className="canvas-memory-field">
        <input
          type="text"
          aria-label="Memory title"
          placeholder="Short title, optional"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          ref={bodyRef}
          aria-label="Memory body"
          placeholder={
            presentation.reachesAgents
              ? "What should every agent in this project know?"
              : "Anything worth keeping next to this project."
          }
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>

      <div className="canvas-memory-compose-actions">
        <input
          type="text"
          className="canvas-memory-tags"
          aria-label="Tags"
          placeholder="#tags"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
        <button type="button" className="canvas-memory-btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="canvas-memory-btn-primary" aria-label="Save memory">
          Save
          <span className="canvas-memory-kbd">⌘⏎</span>
        </button>
      </div>
    </form>
  );
}
