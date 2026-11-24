"use client";

interface Props {
  text: string;
  /** Absent for a plain notice (a refused create): the toast is then text only. */
  onUndo?: () => void;
}

/** The "moved into / left a Frame" toast with its Undo (membership, NL commands, switcher moves). */
export function CanvasFrameToast({ text, onUndo }: Props) {
  return (
    <div className="canvas-intake-notice" role="status" data-testid="frame-membership-toast" style={{ top: "auto", bottom: "4.5rem" }}>
      <span>{text}</span>
      {onUndo ? <span aria-hidden="true">{"·"}</span> : null}
      {onUndo ? <button
        type="button"
        onClick={onUndo}
        style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", color: "var(--canvas-accent)", fontWeight: 600 }}
      >
        Undo
      </button> : null}
    </div>
  );
}
