"use client";

export function CanvasProjectRestoringState() {
  return (
    <section className="canvas-project-restoring" role="status" aria-label="Restoring canvas" aria-busy="true">
      <span className="canvas-project-restoring-dot" aria-hidden />
      <span>Restoring canvas…</span>
    </section>
  );
}
