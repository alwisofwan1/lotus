import { getS2sVoiceDiagnosticsSnapshot, stringifyS2sVoiceDiagnostics } from "./s2s-voice-diagnostics";

export type S2sVoiceDiagnosticsCopyResult = "copied" | "empty" | "unavailable" | "failed";

function defaultClipboard(): Pick<Clipboard, "writeText"> | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.clipboard;
}

export async function copyS2sVoiceDiagnostics(clipboard: Pick<Clipboard, "writeText"> | undefined = defaultClipboard()): Promise<S2sVoiceDiagnosticsCopyResult> {
  const snapshot = getS2sVoiceDiagnosticsSnapshot();
  if (
    snapshot.events.length === 0 &&
    snapshot.healthEvents.length === 0 &&
    snapshot.latencyEvents.length === 0
  ) return "empty";
  if (!clipboard?.writeText) return "unavailable";
  try {
    await clipboard.writeText(stringifyS2sVoiceDiagnostics(snapshot));
    return "copied";
  } catch {
    return "failed";
  }
}
