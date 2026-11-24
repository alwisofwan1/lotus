"use client";
import { useEffect, useState, type ReactNode } from "react";

/** Must match the `.ui-collapse` transition in styles/ui-kit.css. */
const CLOSE_MS = 280;

/**
 * Opens and closes a block with a height + fade (CSS grid rows, no measuring). Children mount on
 * open and unmount after the close animation, so a closed block costs nothing and is not in the
 * accessibility tree.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  if (open && !mounted) setMounted(true); // mount at once on open (state adjusted during render)

  useEffect(() => {
    if (open) {
      // One frame at 0fr first, so the grid-rows transition has a start value.
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    const timer = setTimeout(() => {
      setShown(false);
      setMounted(false);
    }, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;
  return (
    <div className="ui-collapse" data-open={open && shown ? "" : undefined} inert={!open}>
      <div className="ui-collapse-clip">
        <div className="ui-collapse-inner">{children}</div>
      </div>
    </div>
  );
}
