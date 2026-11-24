"use client";

import { useEffect, type RefObject } from "react";

interface UseDismissableLayerOptions<T extends HTMLElement> {
  open: boolean;
  ref: RefObject<T | null>;
  onDismiss: () => void;
}

export function useDismissableLayer<T extends HTMLElement>({
  open,
  ref,
  onDismiss,
}: UseDismissableLayerOptions<T>) {
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target)) return;

      onDismiss();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      event.preventDefault();
      onDismiss();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss, open, ref]);
}
