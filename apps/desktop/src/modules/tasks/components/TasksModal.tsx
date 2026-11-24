"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * The one modal shape the tracker uses — New task and the preset editor.
 *
 * Drawn inside the Tasks surface, not over the whole window: the rail stays live and visible, the
 * same way the Tasks panel itself never covers the rail it was opened from.
 *
 * Escape and a click on the dimmed backdrop both close. Focus goes to the first field on open (the
 * caller marks it `autoFocus`) and back to whatever opened the modal on close, so the keyboard
 * never ends up on `<body>`.
 */
export function TasksModal({
  labelledBy,
  onClose,
  size = "md",
  className,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  size?: "md" | "lg";
  className?: string;
  children: ReactNode;
}) {
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  return (
    <div
      className="tk-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={["tk-modal", `tk-modal--${size}`, className].filter(Boolean).join(" ")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <button type="button" className="tk-modal-close" onClick={onClose} aria-label="Close">
          <X size={15} strokeWidth={1.75} />
        </button>
        {children}
      </div>
    </div>
  );
}
