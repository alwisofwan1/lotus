"use client";
import { SquareDashed } from "lucide-react";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

interface Props {
  onDismiss: () => void;
}

/**
 * First-Frame hint (decision 22, mockup 8b): three ways to start a Frame, shown once.
 * occlusion-exempt: a small note card that sits low and centred, never over a working surface the user
 * is interacting with, and is dismissed once; it takes no pointer layer over the canvas.
 */
export function CanvasFrameHint({ onDismiss }: Props) {
  const shortcut = useFormatShortcut();
  return (
    <aside className="canvas-frame-hint" role="note" aria-label="Group work into Frames" data-testid="frame-first-hint">
      <h3><SquareDashed size={16} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 8 }} />Group work into Frames</h3>
      <ul>
        <li><kbd>{shortcut("⌘G")}</kbd><span>Select nodes, then group them</span></li>
        <li><kbd>N</kbd><span>Press N and drag an empty Frame</span></li>
        <li><kbd>+</kbd><span>Or use + here in the bar</span></li>
      </ul>
      <div className="canvas-frame-hint-foot">
        <span>Then jump between them with {shortcut("⌥1–9")}.</span>
        <button type="button" className="canvas-frame-hint-ok" onClick={onDismiss}>Got it</button>
      </div>
    </aside>
  );
}
