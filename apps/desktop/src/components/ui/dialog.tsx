"use client";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface DialogProps {
  title: ReactNode;
  description?: ReactNode;
  /** Esc, a click on the scrim. */
  onClose: () => void;
  /** Right-aligned row under the body. Put the primary action last. */
  footer?: ReactNode;
  /** `alertdialog` for a question the user must answer. */
  role?: "dialog" | "alertdialog";
  className?: string;
  children?: ReactNode;
}

/**
 * The centered modal card (mockups/quit-with-agents-v2.html, mockups/bug-report.html): dark scrim,
 * no blur, 14px card. Not a portal — mount it where the state lives; `fixed` covers the window.
 */
export function Dialog({ title, description, onClose, footer, role = "dialog", className, children }: DialogProps) {
  const titleId = useId();
  return (
    <div
      className="ui-scrim fixed inset-0 z-[100] grid place-items-center p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
        className={cn(
          "ui-dialog-in w-full max-w-[360px] rounded-[14px] bg-(--ui-card) px-5 pt-5 pb-4 text-[13px] text-(--ui-ink) shadow-[0_0_0_0.5px_var(--ui-line-strong),0_32px_80px_color-mix(in_oklab,var(--ui-shade)_45%,transparent)]",
          className,
        )}
      >
        <p id={titleId} className="text-[15px] font-semibold tracking-[-0.01em]">{title}</p>
        {description ? <p className="mt-1 text-(--ui-ink-3)">{description}</p> : null}
        {children}
        {footer ? <div className="mt-4 flex items-center justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}
