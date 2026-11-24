/**
 * TypeScript mirror of src-tauri/src/remote_error.rs.
 *
 * When a Tauri SSH command fails with AppError::Remote(...), the IPC layer
 * sends the error serialised as { code: "NOT_FOUND" } etc. Call
 * parseRemoteError() on the raw caught value to get a typed RemoteError.
 */

// ── Discriminated union ────────────────────────────────────────────────────────

export type RemoteError =
  | { code: "NOT_FOUND" }
  | { code: "PARENT_NOT_FOUND" }
  | { code: "ESCAPE" }
  | { code: "NOT_A_FILE" }
  | { code: "ALREADY_EXISTS" }
  | { code: "IS_ROOT" }
  | { code: "MTIME_CONFLICT"; current_mtime: number | null }
  | { code: "TOO_LARGE"; size: number; limit: number }
  | { code: "AUTH_FAILURE" }
  | { code: "TIMEOUT" }
  | { code: "OTHER"; message: string };

const KNOWN_CODES = new Set([
  "NOT_FOUND",
  "PARENT_NOT_FOUND",
  "ESCAPE",
  "NOT_A_FILE",
  "ALREADY_EXISTS",
  "IS_ROOT",
  "MTIME_CONFLICT",
  "TOO_LARGE",
  "AUTH_FAILURE",
  "TIMEOUT",
  "OTHER",
] as const);

// ── Type guard ─────────────────────────────────────────────────────────────────

export function isRemoteError(err: unknown): err is RemoteError {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" && KNOWN_CODES.has(code as RemoteError["code"]);
}

// ── Parser ─────────────────────────────────────────────────────────────────────

/**
 * Convert the raw Tauri error value (caught from a failed `invoke`) into a
 * typed RemoteError.
 *
 * - Object with a known `code` field → returned as-is after narrowing.
 * - Plain string → wrapped in `{ code: "OTHER", message }`.
 * - Anything else → stringified into `{ code: "OTHER", message }`.
 */
export function parseRemoteError(err: unknown): RemoteError {
  if (isRemoteError(err)) return err;
  if (typeof err === "string") return { code: "OTHER", message: err };
  if (typeof err === "object" && err !== null) {
    const raw = err as Record<string, unknown>;
    if (typeof raw.code === "string") {
      return { code: "OTHER", message: `${raw.code}: ${raw.message ?? JSON.stringify(err)}` };
    }
  }
  return { code: "OTHER", message: String(err) };
}

// ── Formatter ──────────────────────────────────────────────────────────────────

/**
 * Human-readable single-sentence message for a RemoteError.
 *
 * Mirrors the Display impl in remote_error.rs. Actionable errors include a
 * concrete next step so the user knows what to do.
 */
export function formatRemoteError(err: RemoteError): string {
  switch (err.code) {
    case "NOT_FOUND":
      return "Remote path not found.";
    case "PARENT_NOT_FOUND":
      return "Remote parent directory does not exist.";
    case "ESCAPE":
      return "Remote path escapes the workspace root.";
    case "NOT_A_FILE":
      return "Remote path is not a regular file.";
    case "ALREADY_EXISTS":
      return "Remote path already exists.";
    case "IS_ROOT":
      return "Refusing to delete the workspace root.";
    case "MTIME_CONFLICT":
      return "Remote file was modified by another process. Reload the file and try again.";
    case "TOO_LARGE":
      return `Remote file is too large (${formatBytes(err.size)} / ${formatBytes(err.limit)} limit).`;
    case "AUTH_FAILURE":
      return "SSH authentication failed. Check that your key is loaded (`ssh-add -l`) or that the right IdentityFile is set in `~/.ssh/config`.";
    case "TIMEOUT":
      return "SSH connection timed out. If you use a Cloudflare tunnel, re-authenticate with `cloudflared access login <your-team-domain>`.";
    case "OTHER":
      return err.message || "An unexpected remote error occurred.";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Severity helper ────────────────────────────────────────────────────────────

export type RemoteErrorSeverity = "recoverable" | "auth" | "conflict" | "fatal";

/**
 * Classify a RemoteError by severity so the UI can decide toast colour,
 * retry logic, and whether to surface a "reload" button.
 */
export function remoteErrorSeverity(err: RemoteError): RemoteErrorSeverity {
  switch (err.code) {
    case "MTIME_CONFLICT":
      return "conflict";
    case "AUTH_FAILURE":
    case "TIMEOUT":
      return "auth";
    case "NOT_FOUND":
    case "PARENT_NOT_FOUND":
    case "ESCAPE":
    case "NOT_A_FILE":
    case "ALREADY_EXISTS":
    case "IS_ROOT":
      return "recoverable";
    case "TOO_LARGE":
    case "OTHER":
      return "fatal";
  }
}
