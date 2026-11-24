import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

import type {
  CodeSpaceStoredWorkspaceLocation,
  EditorCreateEntryResult,
  EditorListEntry,
  EditorReadFileResult,
  EditorWriteFileResult,
} from "./codespace";

/**
 * Wire-compatible mirror of the Rust `cli_tools::SshToolTarget`.
 * Optional fields use `null` (not `undefined`) so they round-trip through
 * `serde_json` without surprises.
 */
export type SshToolTarget = {
  host: string;
  user: string | null;
  port: number | null;
};

export type SshEditorContext = {
  target: SshToolTarget;
  remoteCwd: string;
};

const TAURI_ONLY_ERROR = "SSH editor commands require the Tauri runtime";

/**
 * Coerce a workspace `ssh` location to the `SshEditorContext` expected by the
 * `*_ssh` Tauri commands. Returns `null` when the location is not SSH or is
 * missing required fields.
 */
export function toSshEditorContext(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
): SshEditorContext | null {
  if (!location || location.kind !== "ssh") return null;
  const host = location.host?.trim();
  const remoteCwd = location.remoteCwd?.trim();
  if (!host || !remoteCwd) return null;
  return {
    target: {
      host,
      user: location.user?.trim() || null,
      port: typeof location.port === "number" ? location.port : null,
    },
    remoteCwd,
  };
}

/**
 * Resolve the absolute remote working directory for an SSH workspace.
 *
 * Calls `pwd -P` on the remote (optionally inside `cd <hint>` first). If
 * `hint` is missing, empty, or non-absolute (e.g. `"~"`), returns the user's
 * default shell home — the same place a fresh `ssh host` lands.
 *
 * Used as a best-effort helper for editor roots. Callers must not gate the
 * interactive SSH terminal on this probe because it uses a non-interactive SSH
 * command and can fail before a normal terminal session finishes connecting.
 */
export async function sshResolveRemoteCwd(
  target: SshToolTarget,
  hint?: string,
): Promise<string> {
  if (!isTauri()) throw new Error(TAURI_ONLY_ERROR);
  const trimmed = hint?.trim();
  return tauriInvoke<string>("ssh_resolve_remote_cwd", {
    target,
    hint: trimmed && trimmed.length > 0 ? trimmed : null,
  });
}

export async function editorReadFileSsh(
  context: SshEditorContext,
  relativePath: string,
  options: { allowLarge?: boolean } = {},
): Promise<EditorReadFileResult> {
  if (!isTauri()) throw new Error(TAURI_ONLY_ERROR);
  return tauriInvoke<EditorReadFileResult>("editor_read_file_ssh", {
    target: context.target,
    remoteCwd: context.remoteCwd,
    relativePath,
    ...(options.allowLarge ? { allowLarge: true } : {}),
  });
}

/** The raw bytes of a remote file, for the media viewer (an ArrayBuffer, not JSON). */
export async function editorReadFileBytesSsh(
  context: SshEditorContext,
  relativePath: string,
): Promise<ArrayBuffer> {
  if (!isTauri()) throw new Error(TAURI_ONLY_ERROR);
  return tauriInvoke<ArrayBuffer>("editor_read_file_bytes_ssh", {
    target: context.target,
    remoteCwd: context.remoteCwd,
    relativePath,
  });
}

export async function editorListEntriesSsh(
  context: SshEditorContext,
  maxDepth?: number,
): Promise<EditorListEntry[]> {
  if (!isTauri()) return [];
  return tauriInvoke<EditorListEntry[]>("editor_list_entries_ssh", {
    target: context.target,
    remoteCwd: context.remoteCwd,
    maxDepth: maxDepth ?? null,
  });
}

export async function editorWriteFileSsh(
  context: SshEditorContext,
  relativePath: string,
  content: string,
  expectedMtime?: number,
  encoding?: string,
): Promise<EditorWriteFileResult> {
  if (!isTauri()) throw new Error(TAURI_ONLY_ERROR);
  return tauriInvoke<EditorWriteFileResult>("editor_write_file_ssh", {
    target: context.target,
    remoteCwd: context.remoteCwd,
    relativePath,
    content,
    expectedMtime: expectedMtime ?? null,
    ...(encoding ? { encoding } : {}),
  });
}

export async function editorCreateFileSsh(
  context: SshEditorContext,
  relativePath: string,
): Promise<EditorCreateEntryResult> {
  if (!isTauri()) throw new Error(TAURI_ONLY_ERROR);
  return tauriInvoke<EditorCreateEntryResult>("editor_create_file_ssh", {
    target: context.target,
    remoteCwd: context.remoteCwd,
    relativePath,
  });
}

export async function editorCreateDirectorySsh(
  context: SshEditorContext,
  relativePath: string,
): Promise<EditorCreateEntryResult> {
  if (!isTauri()) throw new Error(TAURI_ONLY_ERROR);
  return tauriInvoke<EditorCreateEntryResult>("editor_create_directory_ssh", {
    target: context.target,
    remoteCwd: context.remoteCwd,
    relativePath,
  });
}

export async function editorDeleteEntrySsh(
  context: SshEditorContext,
  relativePath: string,
): Promise<EditorCreateEntryResult> {
  if (!isTauri()) throw new Error(TAURI_ONLY_ERROR);
  return tauriInvoke<EditorCreateEntryResult>("editor_delete_entry_ssh", {
    target: context.target,
    remoteCwd: context.remoteCwd,
    relativePath,
  });
}

export async function editorRenameEntrySsh(
  context: SshEditorContext,
  fromRelativePath: string,
  toRelativePath: string,
): Promise<EditorCreateEntryResult> {
  if (!isTauri()) throw new Error(TAURI_ONLY_ERROR);
  return tauriInvoke<EditorCreateEntryResult>("editor_rename_entry_ssh", {
    target: context.target,
    remoteCwd: context.remoteCwd,
    fromRelativePath,
    toRelativePath,
  });
}

// ── Workspace capability probe ────────────────────────────────────────────────

/** An agent runner found on a machine, with whatever version it reported. */
export type RemoteRunner = {
  /** The executable as spelled on PATH: `claude`, `codex`, `cursor-agent`, `ccs`, `csp`. */
  id: string;
  /** First line of `--version`, when it answered. Absent means unknown, not missing. */
  version?: string | null;
};

export type RemoteCapabilityProfile = {
  /** "gnu" (Linux) or "bsd" (macOS / some BSDs) */
  statVariant: "gnu" | "bsd";
  /** `fd` binary is available on the remote PATH */
  hasFd: boolean;
  /** `rg` (ripgrep) binary is available on the remote PATH */
  hasRg: boolean;
  /**
   * Which agent runners the machine can actually start.
   *
   * Empty is a fact, not a silence: a machine that could not be probed at all raises instead, so an
   * empty list means "asked, found none".
   */
  runners?: RemoteRunner[];
  /** The machine answers the Standalone Host's health endpoint. */
  hasLotusHost?: boolean;
};

/**
 * Run a single-round-trip probe against the SSH target and cache the result
 * in the Rust-side `RemoteCapabilityStore`. Best-effort — callers should
 * fire-and-forget: the SSH editor works without it, just without the
 * stat-variant optimisation.
 *
 * Also warms the `RemoteTransport` master socket so the first editor
 * operation is fast rather than paying the full TCP+KEX+auth cost.
 */
export async function sshProbeWorkspace(
  target: SshToolTarget,
): Promise<RemoteCapabilityProfile> {
  if (!isTauri()) throw new Error(TAURI_ONLY_ERROR);
  return tauriInvoke<RemoteCapabilityProfile>("ssh_probe_workspace", { target });
}

/** The same probe, with the five-minute cache dropped first — for "Cek ulang mesin". */
export async function machineRecheck(
  target: SshToolTarget,
): Promise<RemoteCapabilityProfile> {
  if (!isTauri()) throw new Error(TAURI_ONLY_ERROR);
  return tauriInvoke<RemoteCapabilityProfile>("machine_recheck", { target });
}
