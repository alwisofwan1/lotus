/**
 * Monaco's own test for "this work was stopped on purpose" (`isCancellationError` in
 * `monaco-editor/esm/vs/base/common/errors.js`): an Error whose name AND message are both
 * "Canceled". Monaco ignores these itself; one that escapes as an unhandled rejection is noise,
 * not a failure. Kept exact, so a real error that happens to say "Canceled" still surfaces.
 *
 * `layout.tsx` repeats this check inline in its early guard script, which cannot import.
 */
export function isMonacoCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === "Canceled" && error.message === "Canceled";
}
