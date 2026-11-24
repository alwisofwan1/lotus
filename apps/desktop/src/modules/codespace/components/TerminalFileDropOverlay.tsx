import { File, FileUp, Server, X } from "lucide-react";

export type TerminalFileDropOverlayState =
  | { kind: "hover"; cellId: string; mode: "local" | "ssh"; cwd: string }
  | { kind: "uploading"; cellId: string; count: number; onCancel?: () => void }
  | { kind: "notice"; message: string; tone: "success" | "error" };

export function TerminalFileDropOverlay({ state, onDismiss }: { state: TerminalFileDropOverlayState | null; onDismiss?: () => void }) {
  if (!state) return null;
  if (state.kind === "notice") {
    return (
      <div className={`terminal-file-drop-notice is-${state.tone}`} role="status" onClick={onDismiss}>
        {state.message}
      </div>
    );
  }

  const uploading = state.kind === "uploading";
  const ssh = state.kind === "hover" && state.mode === "ssh";
  const title = uploading
    ? `Uploading ${state.count} file${state.count === 1 ? "" : "s"}…`
    : ssh
      ? "Drop to upload"
      : "Drop to paste path";
  const detail = uploading
    ? null
    : ssh
      ? `→ ${state.cwd || "remote folder"}`
      : state.cwd || null;
  const Icon = uploading ? FileUp : ssh ? Server : File;

  return (
    <div className="terminal-file-drop-overlay" role="status" aria-label={title}>
      <div className="terminal-file-drop-frame" />
      <div className="terminal-file-drop-card">
        <div className="terminal-file-drop-icon"><Icon className="h-[18px] w-[18px]" /></div>
        <div className="terminal-file-drop-copy">
          <div className="terminal-file-drop-title">{title}</div>
          {detail && <div className="terminal-file-drop-detail">{detail}</div>}
        </div>
        {uploading && state.onCancel && (
          <button type="button" className="terminal-file-drop-cancel" onClick={state.onCancel} aria-label="Cancel upload">
            <X className="h-3 w-3" />
            <span>Cancel</span>
          </button>
        )}
      </div>
    </div>
  );
}
