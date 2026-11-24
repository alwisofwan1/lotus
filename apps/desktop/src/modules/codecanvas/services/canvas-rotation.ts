/**
 * Rotation math for whiteboard shapes. Angles are degrees clockwise, 0 = upright, stored only
 * when non-zero (see normalizeShapeFields). Pure; the drag interaction lives in ShapeNode's
 * rotate handle, which feeds pointer positions through rotationFromPointer.
 */

export interface RotationPoint {
  x: number;
  y: number;
}

/** Wrap any angle into [0, 360). */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * The shape angle implied by dragging the rotate handle to `pointer`: the handle sits above the
 * shape, so pointing straight up from `center` is 0°, right is 90°. `snap` (Shift held) rounds
 * to that increment, wrapping 360 back to 0.
 */
export function rotationFromPointer(
  center: RotationPoint,
  pointer: RotationPoint,
  opts: { snap?: number } = {},
): number {
  const raw = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI + 90;
  const angle = normalizeAngle(raw);
  if (!opts.snap) return angle;
  return normalizeAngle(Math.round(angle / opts.snap) * opts.snap);
}
