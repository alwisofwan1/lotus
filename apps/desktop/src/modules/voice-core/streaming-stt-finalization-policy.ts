/** Full correction window while the provider still has a partial hypothesis or no text yet. */
export const STREAMING_STT_HYPOTHESIS_GRACE_MS = 1_500;
/** Short tail window when all visible text is already provider-final. */
export const STREAMING_STT_SETTLED_TAIL_GRACE_MS = 650;

export function resolveStreamingSttFinalizationGraceMs(input: {
  committed: string;
  interim: string;
}): number {
  return input.committed.trim() && !input.interim.trim()
    ? STREAMING_STT_SETTLED_TAIL_GRACE_MS
    : STREAMING_STT_HYPOTHESIS_GRACE_MS;
}
