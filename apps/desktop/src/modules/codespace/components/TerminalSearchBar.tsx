"use client";
import { useRef, useState, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";

interface TerminalSearchBarProps {
  onFind: (query: string) => void;
  onFindPrev: (query: string) => void;
  onClose: () => void;
  onClearSearch?: () => void;
  onLiveFind?: (query: string) => void;
}

export function TerminalSearchBar({ onFind, onFindPrev, onClose, onClearSearch, onLiveFind }: TerminalSearchBarProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const previousQueryRef = useRef("");

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const previousQuery = previousQueryRef.current;
    previousQueryRef.current = query;
    if (!query) {
      if (previousQuery) onClearSearch?.();
      return;
    }
    (onLiveFind ?? onFind)(query);
  }, [onClearSearch, onFind, onLiveFind, query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          onFindPrev(query);
        } else {
          onFind(query);
        }
      }
    },
    [query, onFind, onFindPrev, onClose],
  );

  return (
    <div className={cn(
      "absolute top-1 right-2 z-10 flex items-center gap-1",
      "glass rounded-xl px-2.5 py-1.5",
    )}>
      <input
        ref={inputRef}
        type="text"
        placeholder="Search..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className={cn(
          "bg-transparent text-[var(--fg)] text-xs font-mono",
          "w-36 outline-none placeholder:text-[var(--text-muted)]",
        )}
      />
      <button
        aria-label="Previous match"
        onClick={() => onFindPrev(query)}
        className="text-[var(--text-muted)] hover:text-[var(--fg)] p-0.5 text-xs"
      >
        &#x25B2;
      </button>
      <button
        aria-label="Next match"
        onClick={() => onFind(query)}
        className="text-[var(--text-muted)] hover:text-[var(--fg)] p-0.5 text-xs"
      >
        &#x25BC;
      </button>
      <button
        aria-label="Close search"
        onClick={onClose}
        className="text-[var(--text-muted)] hover:text-[var(--fg)] p-0.5 text-xs ml-0.5"
      >
        &#x2715;
      </button>
    </div>
  );
}
