/**
 * Camera-thrash guard for narration pierces (Slice 6 of `plans/voice-narration-layer/`).
 *
 * Three agents failing within the same second is exactly when the user least needs the viewport
 * slamming between them. The pierces are all still SPOKEN — only the visual chase is rate-limited.
 */

/**
 * Minimum gap between two camera moves. Long enough that a burst of simultaneous failures settles
 * on one target, short enough that a genuinely later failure is not ignored.
 */
export const FOCUS_MIN_GAP_MS = 1_500;

export interface FocusThrottle {
  /** Whether this pierce should move the camera. Records the move when it returns true. */
  shouldFocus(nodeId: string, now: number): boolean;
}

export function createFocusThrottle(minGapMs: number = FOCUS_MIN_GAP_MS): FocusThrottle {
  let lastNodeId: string | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;

  return {
    shouldFocus(nodeId, now) {
      // Already looking at it — re-issuing the move is pure jitter.
      if (nodeId === lastNodeId) return false;
      if (now - lastAt < minGapMs) return false;
      lastNodeId = nodeId;
      lastAt = now;
      return true;
    },
  };
}
