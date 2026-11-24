/**
 * tauri-api.ts
 * Thin wrapper around Tauri IPC (invoke) that mirrors the shapes of the
 * old fetch-based API calls.  Components import from here instead of
 * calling fetch('/api/...') directly.
 */

import { loadTauriCore, isTauri, tauriInvoke } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
export { isTauri } from "@/lib/tauri/runtime";
export { getSettings, openNewWindow, openPathInEditor, saveSettings } from "@/lib/tauri/app";
export {
  type GitRepoStatus,
  getGitRepoStatus,
} from "@/lib/tauri/project-files";
export {
  closeEmbeddedBrowserPreview,
  goBackEmbeddedBrowserPreview,
  goForwardEmbeddedBrowserPreview,
  openBrowserPreviewWindow,
  openEmbeddedBrowserPreview,
  reloadEmbeddedBrowserPreview,
  syncEmbeddedBrowserPreviewBounds,
} from "@/lib/tauri/browser-preview";
export { type AgentCliAvailability, type AgentCliModels, discoverAgentCliModels, getAgentCliAvailability } from "@/lib/tauri/agent-cli";
export { listProjectDirectoryPaths, listProjects } from "@/lib/tauri/projects";
export { createSkill, importSkillFromUrl, listSkills } from "@/lib/tauri/skills";
export { getCliToolAvailability, getSshCliToolAvailability, getSshGitRepoRoot } from "@/lib/tauri/cli-tools";
export {
  AdminCallError,
  createPairingCode,
  getHostRuntimeStatus,
  getMobileReachability,
  listBindCandidates,
  listMobileDevices,
  revokeMobileDevice,
  type AdminFailureReason,
  type BindCandidate,
  type HostRuntimeStatus,
  type MobileDevice,
  type MobileReachability,
  type Reach,
} from "@/lib/tauri/host-runtime";
export {
  loadCodeSpaceSnapshot,
  saveCodeSpaceSnapshot,
  type CodeSpaceStoredPane,
  type CodeSpaceStoredSnapshot,
  type CodeSpaceStoredWorkspace,
  type CodeSpaceWebviewBounds,
  type EditorCreateEntryResult,
  type EditorReadFileResult,
  type EditorWriteFileResult,
  type EditorListEntry,
  type CodespaceGitChangeKind,
  type CodespaceGitDiffTarget,
  type CodespaceGitFileDiffContent,
  type CodespaceGitFileStatus,
  type CodespaceGitRepoSummary,
  webviewCreate,
  webviewSetBounds,
  webviewNavigate,
  webviewReload,
  webviewBack,
  webviewForward,
  webviewSetVisible,
  webviewDestroy,
  editorReadFile,
  editorWriteFile,
  editorCreateFile,
  editorCreateDirectory,
  editorDeleteEntry,
  editorListFiles,
  editorListEntries,
  codespaceGitStatus,
  codespaceGitRepoSummary,
  codespaceGitStageFile,
  codespaceGitStageAll,
  codespaceGitUnstageFile,
  codespaceGitUnstageAll,
  codespaceGitDiscardAllChanges,
  codespaceGitCommit,
  codespaceGitPush,
  codespaceGitAiSuggestCommit,
  codespaceGitDiffFile,
  codespaceGitDiffFileContent,
} from "@/lib/tauri/codespace";

// ─── Re-exported types (match server-side shapes) ────────────────────────────

export interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
  model?: string;
  role?: string;
  status?: string;
  pid?: number;
  runner?: import("@/lib/agent-runtime").AgentRunnerType;
  runnerCommand?: string;
  prompt?: string;
  appliedSkills?: string[];
  effort?: string;
  permissionMode?: string;
}

export interface TeamConfig {
  id: string;
  name: string;
  /**
   * Shape of this file on disk. Absent means version 0 — written before member `prompt`,
   * `effort`, `appliedSkills` and `permissionMode` were persisted, so those fields are missing
   * and a load-time migration fills them. See `services/team-config-migration.ts`.
   */
  schemaVersion?: number;
  description?: string;
  project?: string;
  projectDir?: string;
  displayMode?: string;
  requirePlanApproval?: boolean;
  leadModel?: string;
  createdAt: string;
  status: "active" | "idle" | "completed" | "failed";
  members: TeamMember[];
}

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasPackageJson: boolean;
}

export interface ProjectMeta {
  id: string;
  path: string;
  name: string;
  lastUsed?: string;
}

export interface SshConfigHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  /**
   * The Cloudflare Access application this host is reached through, when it is one.
   *
   * Read off the host's `ProxyCommand`. Its presence is what lets an expired browser sign-in be
   * named as such instead of surfacing as "the machine timed out".
   */
  accessHostname?: string | null;
}

/** Whether a machine is ready to use, answered from cheap local facts rather than a probe. */
export interface MachineReadiness {
  /** A live SSH master already exists for this target. */
  connected: boolean;
  /** Present only for hosts behind Cloudflare Access. */
  access?: {
    state: "signed-in" | "needs-login" | "unavailable";
    hostname: string;
  } | null;
}

export interface SessionInfo {
  id: string;
  cwd: string;
}

export interface EditorAvailability {
  vscode: boolean;
  cursor: boolean;
  antigravity: boolean;
  antigravityApp: boolean;
}

// ─── Teams ────────────────────────────────────────────────────────────────────

export async function listTeams(): Promise<TeamConfig[]> {
  return tauriInvoke<TeamConfig[]>("list_teams");
}

// ─── Subscription usage (plans/subscription-usage) ───────────────────────────

export async function getUsageSnapshot(): Promise<import("@/modules/workspace-shell/services/usage").UsageAccount[]> {
  return tauriInvoke("usage_snapshot");
}

/** New chats and terminals run as this account (Lotus only; nothing outside Lotus changes). */
export async function chooseUsageAccount(account: string | null, provider: AccountProvider = "claude"): Promise<void> {
  return tauriInvoke("usage_use_account", { account, provider });
}

/** Usage of the machines with an SSH connection open now (their Lotus Host), plus the last numbers of others. */
export async function getRemoteUsage(): Promise<import("@/modules/workspace-shell/services/usage").MachineUsage[]> {
  return tauriInvoke("usage_remote");
}

/** A Claude subscription account as `accounts_list` (src-tauri/src/accounts.rs) returns it. */
export interface AccountView {
  id: string;
  source: "default" | "env" | "ccs" | "lotus";
  dir: string;
  identity: { email: string; org: string | null } | null;
  inUse: boolean;
  /** Run in a terminal to sign this account in (POSIX shells). */
  loginCommand: string;
  /** Lotus-made accounts only: linked to `~/.claude` (`shared`) or not (`isolated`). */
  context?: "shared" | "isolated" | null;
  /** Removed from Lotus: out of every picker, listed only in Settings so it can come back. */
  hidden?: boolean;
}

/** Every account, hidden ones included (`hidden: true`); pickers filter them out. */
/** Which CLI an account signs in; each has its own list and its own default. */
export type AccountProvider = "claude" | "codex";

export async function listAccounts(provider: AccountProvider = "claude"): Promise<AccountView[]> {
  return tauriInvoke("accounts_list", { provider });
}

/** A CLI with one login per Mac user (Antigravity): who it is, never a list. */
export interface SingleLogin {
  signedIn: boolean;
  email: string | null;
  loginCommand: string;
}

/** Antigravity's login on this Mac; null when `agy` is not installed. */
export async function getAntigravityLogin(): Promise<SingleLogin | null> {
  return tauriInvoke("antigravity_login");
}

/** Shows an account removed from Lotus again. */
export async function unhideAccount(id: string, provider: AccountProvider = "claude"): Promise<void> {
  return tauriInvoke("account_unhide", { id, provider });
}

/** What deleting an account's folder would hit; asked when its confirm opens. */
export interface AccountRemovalCheck {
  /** `<pid> <name>` of each process running on the account now. */
  running: string[];
  /** The folder holds chats that exist nowhere else. */
  ownHistory: boolean;
}

export async function accountRemovalCheck(id: string, provider: AccountProvider = "claude"): Promise<AccountRemovalCheck> {
  return tauriInvoke("account_removal_check", { id, provider });
}

/** A new Lotus account folder; it is not signed in until its login command runs. */
export async function createAccount(name: string, isolated = false, provider: AccountProvider = "claude"): Promise<AccountView> {
  return tauriInvoke("account_create", { name, isolated, provider });
}

/**
 * A `lotus` account: deleted (folder + keychain item). A `ccs`/`env` one: hidden from Lotus, files
 * untouched, unless `purge` (ccs only) deletes its folder and login too. Never the default.
 */
export async function removeAccount(id: string, purge = false, provider: AccountProvider = "claude"): Promise<void> {
  return tauriInvoke("account_remove", { id, purge, provider });
}

/** Moving off ccs (plans/portable-accounts/issues/08), as `ccs_migration.rs` plans it. */
export interface CcsMigrationPlan {
  backup: string;
  merges: { from: string; to: string; collisions: number }[];
  /** `to: null`: nothing outside `~/.ccs` to point at, left as it is. */
  relinks: { link: string; to: string | null }[];
  defaultAccount: string | null;
  mcpEntries: { file: string; name: string }[];
}

/** null when the machine has no `~/.ccs`. `target`: another machine's Lotus Host, over its open SSH. */
export async function planCcsMigration(target: string | null = null): Promise<CcsMigrationPlan | null> {
  return target ? tauriInvoke("remote_ccs_migration", { target, action: "plan" }) : tauriInvoke("ccs_migration_plan");
}

/** Backs up what it changes first; locally that takes a few minutes. */
export async function runCcsMigration(target: string | null = null): Promise<CcsMigrationPlan> {
  return target ? tauriInvoke("remote_ccs_migration", { target, action: "run" }) : tauriInvoke("ccs_migration_run");
}

export async function removeCcsMcpEntries(target: string | null = null): Promise<{ file: string; name: string }[]> {
  return target ? tauriInvoke("remote_ccs_migration", { target, action: "remove-mcp" }) : tauriInvoke("ccs_migration_remove_mcp");
}

/** Another machine's Claude accounts, by the `target` key `usage_remote` reports; needs its SSH open. */
export async function listRemoteAccounts(target: string): Promise<{ machine: string; accounts: AccountView[] }> {
  return tauriInvoke("remote_accounts_list", { target });
}

export async function createRemoteAccount(target: string, name: string, isolated = false): Promise<AccountView> {
  return tauriInvoke("remote_account_create", { target, name, isolated });
}

/** Deletes a Lotus-made account on that machine, its login with it. */
export async function removeRemoteAccount(target: string, id: string): Promise<void> {
  return tauriInvoke("remote_account_remove", { target, id });
}

/** Which account that machine's own spawns run as; null goes back to its default login. */
export async function setRemoteDefaultAccount(target: string, id: string | null): Promise<void> {
  return tauriInvoke("remote_account_default", { target, id });
}

// CodeCanvas Artisan Theme Engine (ADR-0023, Phase 3). User/agent-authored themes
// live under ~/.lotus/canvas-themes/. Both wrappers degrade gracefully outside
// Tauri (or before the Rust commands exist) so the built-in catalog still works.
export async function listCanvasThemes(): Promise<unknown[]> {
  if (!isTauri()) return [];
  try {
    return await tauriInvoke<unknown[]>("list_canvas_themes");
  } catch {
    return [];
  }
}

export interface SaveCanvasThemeResult {
  ok: boolean;
  id?: string;
  errors?: string[];
}

export async function saveCanvasTheme(spec: unknown): Promise<SaveCanvasThemeResult> {
  if (!isTauri()) return { ok: false, errors: ["canvas theme authoring requires the desktop app"] };
  try {
    return await tauriInvoke<SaveCanvasThemeResult>("save_canvas_theme", { spec });
  } catch (err) {
    return { ok: false, errors: [String(err)] };
  }
}

export interface CanvasThemeAsset {
  mime: string;
  base64: string;
}

/** Read a theme's local media asset (relative to its folder) as base64. Null outside Tauri. */
export async function readCanvasThemeAsset(themeId: string, rel: string): Promise<CanvasThemeAsset | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<CanvasThemeAsset>("read_canvas_theme_asset", { themeId, rel });
  } catch {
    return null;
  }
}

/**
 * Asset-protocol URL for a theme's local media — preferred for VIDEO (streams via
 * Range requests, no whole-file-in-memory). Resolves the absolute path in Rust then
 * runs it through convertFileSrc. Null outside Tauri.
 */
export async function canvasThemeMediaUrl(themeId: string, rel: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const path = await tauriInvoke<string>("canvas_theme_asset_path", { themeId, rel });
    const core = await loadTauriCore();
    return core.convertFileSrc(path);
  } catch {
    return null;
  }
}

export async function getTeam(id: string): Promise<TeamConfig | null> {
  return tauriInvoke<TeamConfig | null>("get_team", { id });
}

export async function deleteTeam(id: string): Promise<void> {
  return tauriInvoke("delete_team", { id });
}

// ─── Bridge Tasks (workspace-scoped, Jira/Linear model) ──────────────────────

export type BridgeSubTaskStatus = "pending" | "in-progress" | "completed";
export type BridgeTaskStatus = "todo" | "in-progress" | "blocked" | "in-review" | "complete" | "cancelled";
export type BridgePriority = "none" | "low" | "medium" | "high";

export interface BridgeSubTask {
  id: string;
  title: string;
  status: BridgeSubTaskStatus;
  assignedTo?: string;
}

export type BridgeTaskIntakeDecision = "assign" | "ask-human" | "blocked";

export interface BridgeTaskIntake {
  briefXml: string;
  confidence: number;
  decision: BridgeTaskIntakeDecision;
  updatedAt: number;
}

export interface BridgeTaskBlocker {
  phase: "intake" | "assignment" | "execution" | "review";
  type: "human-input" | "ambiguity" | "auth" | "dependency" | "verification-failed" | "system-error";
  reason: string;
  questionId?: string;
}

export interface BridgeTaskFeedbackEvent {
  id: string;
  at: number;
  actor: "director" | "human" | "agent" | "reviewer" | "system";
  kind:
    | "intake-created"
    | "hitl-question"
    | "hitl-answer"
    | "assignment-plan-created"
    | "assignment-dispatched"
    | "agent-result"
    | "review-requested"
    | "review-verdict"
    | "revision-requested"
    | "task-blocked"
    | "task-status-changed";
  summary: string;
  payload?: unknown;
}

export interface BridgeTask {
  id: string;
  workspaceId: string;
  teamId?: string;
  title: string;
  goal: string;
  knowledge: string;
  status: BridgeTaskStatus;
  priority: BridgePriority;
  assignees: string[];
  createdAt: number;
  updatedAt: number;
  cellId?: string;
  lastError?: string;
  subtasks?: BridgeSubTask[];
  dueDate?: number;
  intake?: BridgeTaskIntake;
  blocker?: BridgeTaskBlocker;
  feedbackEvents?: BridgeTaskFeedbackEvent[];
}

export async function bridgeGetTask(
  workspaceId: string,
  taskId: string,
): Promise<BridgeTask | null> {
  return tauriInvoke<BridgeTask | null>("bridge_get_task", { workspaceId, taskId });
}

// ─── Smart Convert ─────────────────────────────────────────────────────────────

/** One-shot provider CLI call that converts raw note content into a structured task JSON string.
 *  The caller is responsible for parsing the returned string via parseSmartConvertDraft(). */
export async function smartConvertNote(content: string, model: string, provider = "claude"): Promise<string> {
  return tauriInvoke<string>("smart_convert_note", { content: String(content), model: String(model), provider });
}

// ─── Directory browser / Projects ────────────────────────────────────────────

/** Windows: pop the app menu's `menu` submenu (File/Edit/Window/Help) at window point x,y. */
export async function showWindowMenu(menu: string, x: number, y: number): Promise<void> {
  return tauriInvoke<void>("show_window_menu", { menu, x, y });
}

export async function getHomedir(): Promise<string> {
  return tauriInvoke<string>("get_homedir");
}

export async function listDirEntries(browsePath: string): Promise<DirEntry[]> {
  if (!isTauri()) {
    const res = await fetch(`/api/projects?browse=${encodeURIComponent(browsePath)}`);
    if (!res.ok) throw new Error(`Failed to list directory: ${res.statusText}`);
    return res.json();
  }
  return tauriInvoke<DirEntry[]>("list_dir_entries", { browsePath });
}

/**
 * Child directories of a path on another machine.
 *
 * Separate from {@link listDirEntries} rather than a flag on it, because the two answer to different
 * failures: a local path that does not exist is simply an empty list, while a remote one is either
 * "not there" or "you may not look" — and the picker has to say which.
 */
export async function listDirEntriesSsh(
  target: { host: string; user?: string; port?: number },
  browsePath: string,
): Promise<DirEntry[]> {
  return tauriInvoke<DirEntry[]>("list_dir_entries_ssh", { target, browsePath });
}

/**
 * Ask whether a machine is ready, without connecting to it.
 *
 * Deliberately cheap: an existing SSH master plus, for Access hosts, whether a token exists. A
 * picker that probed every row would spend the operator's first seconds on the very hosts that are
 * slow — which is the failure this whole flow exists to avoid.
 */
export async function machineReadiness(
  target: { host: string; user?: string; port?: number },
  accessHostname?: string | null,
): Promise<MachineReadiness> {
  return tauriInvoke<MachineReadiness>("machine_readiness", {
    target,
    accessHostname: accessHostname ?? null,
  });
}

/** Where a process on another machine reaches this desktop, and the bearer it must present. */
export interface LotusApiCredentials {
  port: number;
  key: string;
}

export async function lotusApiCredentials(): Promise<LotusApiCredentials> {
  return tauriInvoke<LotusApiCredentials>("lotus_api_credentials");
}

/**
 * The way home for a machine: `ssh -R` pointing its loopback at this desktop's.
 *
 * `open` is idempotent — asking twice returns the tunnel already up — so any surface that needs the
 * route back can simply ask rather than coordinate with the others.
 */
export interface TunnelStatus {
  state: "open" | "closed" | "failed";
  /** The loopback ports forwarded, identical on both ends. */
  ports: number[];
  /** What ssh said when it stopped. Present only on `failed`. */
  detail?: string | null;
}

export async function machineTunnelOpen(
  target: { host: string; user?: string; port?: number },
): Promise<TunnelStatus> {
  return tauriInvoke<TunnelStatus>("machine_tunnel_open", { target });
}

export async function machineTunnelStatus(
  target: { host: string; user?: string; port?: number },
): Promise<TunnelStatus> {
  return tauriInvoke<TunnelStatus>("machine_tunnel_status", { target });
}

export async function machineTunnelClose(
  target: { host: string; user?: string; port?: number },
): Promise<TunnelStatus> {
  return tauriInvoke<TunnelStatus>("machine_tunnel_close", { target });
}

/** Let go of a machine on purpose: the way home and the pooled master. Open terminals stay alive. */
export async function machineDisconnect(
  target: { host: string; user?: string; port?: number },
): Promise<TunnelStatus> {
  return tauriInvoke<TunnelStatus>("machine_disconnect", { target });
}

/** What `machine_install_hooks` did on the far side. */
export interface RemoteHookInstall {
  /** Where the hook script now lives on that machine. */
  scriptPath: string;
  /** `false` when its settings already said exactly this, so nothing was written. */
  changed: boolean;
  /** How many Claude hook events are wired to it. */
  events: number;
}

/**
 * Teach a machine to report its agents home.
 *
 * Writes a small `sh` hook script to `$HOME` and wires it into that machine's
 * `~/.claude/settings.json`, merging rather than replacing — hooks already there are kept. Safe to
 * call on every connect: a machine already set up is detected and nothing is written.
 *
 * Rejects rather than guesses when that settings file exists but is not valid JSON: replacing a file
 * we could not read, on someone else's machine, is not a thing to do quietly.
 */
export async function machineInstallHooks(
  target: { host: string; user?: string; port?: number },
): Promise<RemoteHookInstall> {
  return tauriInvoke<RemoteHookInstall>("machine_install_hooks", { target });
}

/** One cell a machine's Standalone Host is running. */
export interface RemoteHostCell {
  paneId: string;
  workspaceId: string;
  cwd: string;
  provider: string;
  status: string;
  isAlive: boolean;
  displayName?: string;
  lastOutputPreview?: string;
  /**
   * Whether this cell has a terminal at all — the field adoption branches on.
   *
   * A `tui` cell runs under tmux, so a canvas node attaches to it over ssh and gets the bytes.
   * A headless one has no terminal to attach to: its runner speaks a structured protocol and the
   * host holds the turns in memory, so it is adopted as a conversation read through
   * `machineHostConversation` instead.
   *
   * Optional here rather than required because a host that predates the field simply omits it;
   * Rust defaults it to `true` for exactly that case (`remote_lotus_host.rs`), and everything that
   * reads it must treat "absent" as "has a terminal" for the same reason — every cell such a host
   * could report came from its PTY manager.
   */
  tui?: boolean;
}

/** What a machine's Standalone Host has to offer, or the fact that it runs none. */
export interface RemoteHostFleet {
  /** `false` means this machine runs no host — the ordinary case, and not an error. */
  available: boolean;
  cells: RemoteHostCell[];
}

/**
 * Ask a machine what its Standalone Host is running.
 *
 * Reaches the host through the SSH connection that is already open — the host binds loopback over
 * there and writes its port and key to a discovery file, both of which are read on that side. No
 * tunnel, no pairing, and the key never leaves the machine that owns it.
 */
export async function machineHostFleet(
  target: { host: string; user?: string | null; port?: number | null },
): Promise<RemoteHostFleet> {
  return tauriInvoke<RemoteHostFleet>("machine_host_fleet", { target });
}

/** Send a prompt to a cell that machine's host owns. */
export async function machineHostDispatch(
  target: { host: string; user?: string | null; port?: number | null },
  paneId: string,
  command: string,
): Promise<void> {
  return tauriInvoke<void>("machine_host_dispatch", { target, paneId, command });
}

/**
 * The turns of a cell that machine's host runs without a terminal.
 *
 * Returns the host's own `ConversationPage`, unparsed and unreshaped — `unknown` on purpose. Rust
 * passes the page straight through for the stated reason that the format is the host's, and a
 * second model here would be the same copy to keep in step, one layer up. The canvas reads it
 * through `services/host-conversation.ts`, which is written to survive fields it has never seen.
 *
 * Rejects rather than resolving empty when the pane has no conversation — a `tui` cell, or one the
 * host no longer runs. An empty page and "that is not this kind of cell" must not look alike.
 */
export async function machineHostConversation(
  target: { host: string; user?: string | null; port?: number | null },
  paneId: string,
): Promise<unknown> {
  return tauriInvoke<unknown>("machine_host_conversation", { target, paneId });
}

/**
 * Open the Cloudflare Access sign-in for a machine.
 *
 * Resolves with the URL cloudflared opened, when it reports one, so the caller can offer it if the
 * browser did not come up. `null` is not a failure — the browser may well already be open.
 */
export async function machineAccessLogin(hostname: string): Promise<string | null> {
  return tauriInvoke<string | null>("machine_access_login", { hostname });
}

export async function listSshHosts(): Promise<SshConfigHost[]> {
  if (!isTauri()) {
    return [];
  }

  return tauriInvoke<SshConfigHost[]>("list_ssh_hosts");
}

export async function openExternalLink(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  return tauriInvoke("open_external_link", { url });
}

export async function openPathReference(
  path: string,
  cwd: string,
  line?: number,
  column?: number,
): Promise<void> {
  if (!isTauri()) {
    return;
  }

  return tauriInvoke("open_path_reference", { path, cwd, line, column });
}

export async function getEditorAvailability(): Promise<EditorAvailability> {
  if (!isTauri()) {
    return { vscode: false, cursor: false, antigravity: false, antigravityApp: false };
  }

  return tauriInvoke<EditorAvailability>("get_editor_availability");
}

// ─── PTY sessions ─────────────────────────────────────────────────────────────

/**
 * Create a PTY session. Returns a sessionId.
 * The `onOutput` callback receives streamed PTY output.
 * Pass `cols`/`rows` so the PTY starts at the correct terminal dimensions.
 */
/**
 * Decode raw bytes from `Channel<Vec<u8>>` to a string. Tauri serialises
 * `Vec<u8>` as a JSON number array, so the callback receives `number[]`.
 * `TextDecoder` with `stream:true` buffers incomplete multi-byte sequences
 * across chunks, eliminating the split-UTF-8 drop bug in the old Rust
 * `flush_valid` path.
 */
function makePtyDecoder(onOutput: (data: string) => void): (raw: unknown) => void {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return (raw: unknown) => {
    let bytes: Uint8Array;
    if (Array.isArray(raw)) {
      bytes = new Uint8Array(raw as number[]);
    } else if (raw instanceof ArrayBuffer) {
      bytes = new Uint8Array(raw);
    } else if (raw instanceof Uint8Array) {
      bytes = raw;
    } else {
      // Fallback: already a decoded string (shouldn't happen with Vec<u8>).
      onOutput(raw as string);
      return;
    }
    const text = decoder.decode(bytes, { stream: true });
    if (text) onOutput(text);
  };
}

export async function createPtySession(
  cwd: string,
  cols: number,
  rows: number,
  onOutput: (data: string) => void,
  paneId?: string,
  canvasTerminalId?: string,
  claudeAccount?: string | null,
): Promise<string> {
  if (!isTauri()) {
    throw new Error(
      `Tauri IPC unavailable: "create_session" requires the desktop app. Run via \`bun run tauri:dev\`.`
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { invoke, Channel } = await loadTauriCore() as any;
  const channel = new Channel();
  channel.onmessage = makePtyDecoder(onOutput);
  return (invoke as (cmd: string, args?: Record<string, unknown>) => Promise<string>)(
    "create_session", {
      cwd,
      paneId: paneId ?? null,
      canvasTerminalId: canvasTerminalId ?? null,
      claudeAccount: claudeAccount ?? null,
      cols,
      rows,
      onOutput: channel,
    }
  );
}

export async function createCommandPtySession(
  cwd: string,
  command: string[],
  cols: number,
  rows: number,
  onOutput: (data: string) => void,
  paneId?: string,
  canvasTerminalId?: string,
  claudeAccount?: string | null,
): Promise<string> {
  if (!isTauri()) {
    throw new Error(
      `Tauri IPC unavailable: "create_command_session" requires the desktop app. Run via \`bun run tauri:dev\`.`
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { invoke, Channel } = await loadTauriCore() as any;
  const channel = new Channel();
  channel.onmessage = makePtyDecoder(onOutput);
  return (invoke as (cmd: string, args?: Record<string, unknown>) => Promise<string>)(
    "create_command_session", { cwd, paneId: paneId ?? null, canvasTerminalId: canvasTerminalId ?? null, command, claudeAccount: claudeAccount ?? null, cols, rows, onOutput: channel }
  );
}

/**
 * The session a pane left running in the session daemon (a restart or reload, ADR-0067), mirrored
 * to `onOutput` starting with its drawn screen. `null` when there is none: start one.
 */
export async function adoptPtySession(paneId: string, onOutput: (data: string) => void): Promise<string | null> {
  if (!isTauri()) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { invoke, Channel } = await loadTauriCore() as any;
  const channel = new Channel();
  channel.onmessage = makePtyDecoder(onOutput);
  return (invoke as (cmd: string, args?: Record<string, unknown>) => Promise<string | null>)(
    "adopt_session", { paneId, onOutput: channel }
  );
}

/** Once this window restored its panes: ends the daemon sessions whose pane is gone. */
export async function reconcilePtySessions(paneIds: string[]): Promise<number> {
  if (!isTauri()) return 0;
  return tauriInvoke<number>("reconcile_sessions", { paneIds });
}

export async function writeToSession(sessionId: string, data: string): Promise<void> {
  return tauriInvoke("write_to_session", { sessionId, data });
}

export async function resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
  return tauriInvoke("resize_session", { sessionId, cols, rows });
}

export async function killPtySession(sessionId: string): Promise<void> {
  return tauriInvoke("kill_session", { sessionId });
}

/** Kill the current window's PTY sessions, Canvas agents included. Not for reload cleanup:
 *  Rust already does that on page load (`on_page_load` in lib.rs). Window-scoped so it never
 *  kills another Lotus window's live sessions. */
export async function closeWindowPtySessions(): Promise<number> {
  return tauriInvoke<number>("close_window_sessions");
}

export async function listPtySessions(): Promise<SessionInfo[]> {
  return tauriInvoke<SessionInfo[]>("list_sessions");
}

// ─── Pane title generation ───────────────────────────────────────────────────
// A pane's title comes from its agent's own transcript: the CLI's own title when it wrote one
// (`getPaneAgentTitle`, no model call), otherwise a one-shot sidecar over the first typed
// prompt and the latest reply (`generatePaneTitle` with `paneId`). The PTY screen is only the
// legacy source, for callers that pass `sessionId` alone.

export interface PaneAgentTitle {
  /** Which conversation: the transcript path. Changes when the pane starts another one. */
  sessionKey: string;
  /** The agent CLI's own title (Claude `ai-title`, Codex `thread_name`), when it wrote one. */
  title?: string;
  /** Whether the transcript has a typed prompt to make a title from. */
  hasPrompt: boolean;
}

/** What the pane's agent calls its current conversation; null when no transcript is known. */
export async function getPaneAgentTitle(paneId: string): Promise<PaneAgentTitle | null> {
  return tauriInvoke<PaneAgentTitle | null>("pane_agent_title", { paneId });
}

export interface GeneratePaneTitleRequest {
  /** The pane whose agent transcript should be titled. Preferred: the PTY is never read. */
  paneId?: string;
  /** Legacy: PTY session id whose screen output should be summarised. */
  sessionId?: string;
  /** Max bytes of trailing output to read from the ring buffer. */
  maxBytes?: number;
  /** Override model (defaults to `claude-haiku-4-5`). */
  model?: string;
  /** Optional language hint ("Indonesian", "English", …). */
  languageHint?: string;
  /** When false, Rust may use deterministic prompt extraction but must not spawn a CLI. */
  allowAiFallback?: boolean;
  /**
   * The CLI family this pane runs — `claude` (default) or `codex`.
   *
   * A pane is titled by its OWN agent: a codex pane spends codex tokens and works for someone who
   * never signed into Claude. Unknown families fall back to Claude rather than guessing a command
   * line for a binary nobody measured.
   */
  provider?: string;
}

export interface GeneratePaneTitleResult {
  title: string;
  /** Bytes of cleaned transcript that fed the title generator. */
  sourceBytes: number;
}

export async function generatePaneTitle(
  request: GeneratePaneTitleRequest,
): Promise<GeneratePaneTitleResult> {
  return tauriInvoke<GeneratePaneTitleResult>("generate_pane_title", { request });
}

/**
 * Lightweight activity snapshot for a PTY session — used by the auto-title
 * pipeline to decide when turn 1 has settled enough to summarise. The
 * payload is a few u64s; we never ship the actual buffer contents here.
 */
export interface PtyOutputMetrics {
  totalBytes: number;
  bufferLen: number;
  idleMs: number;
  ageMs: number;
  hasOutput: boolean;
  /**
   * Sticky agent identity sniffed from welcome banners (`codex`, `claude`,
   * `gemini`, `cursor`, `opencode`, `aider`, `copilot`). `null` for plain
   * shells. Populated by Rust on each output push and cached for the
   * session, so polling stays cheap. The frontend uses it to promote a
   * shell pane to agent-mode when the user manually typed e.g. `codex`.
   */
  detectedAgent?: string | null;
}

export async function getPtySessionMetrics(
  sessionId: string,
): Promise<PtyOutputMetrics | null> {
  return tauriInvoke<PtyOutputMetrics | null>("pty_session_metrics", { sessionId });
}

/**
 * The last assistant line of a Claude session, for a dormant agent card (Session Widget, Slice 04).
 *
 * Reads the runner's OWN transcript, which is durable and survives the app closing — unlike the PTY
 * ring buffer, which is exactly what is missing when a dormant card is needed. `null` when that
 * transcript is not on disk, so the caller can say "saved" instead of inventing a line.
 */
export async function readClaudeSessionTail(
  cwd: string,
  sessionId: string,
  maxChars?: number,
): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<string | null>("read_claude_session_tail", { cwd, sessionId, maxChars });
  } catch (err) {
    console.warn("[canvas] read_claude_session_tail unavailable (rebuild the app to enable it):", err);
    return null;
  }
}

export async function getClaudeSessionTitle(cwd: string): Promise<string | null> {
  if (!isTauri()) return null;
  return tauriInvoke<string | null>("get_claude_session_title", { cwd });
}

/** List Claude Code session ids (newest first) recorded for a cwd — the `<uuid>.jsonl` stems under
 *  ~/.claude/projects/<slug>/. Used to capture a live agent's real session id for resume (ADR-0027). */
/**
 * Transcript ids recorded for a cwd **on another machine**, newest first.
 *
 * The slug a cwd maps to is derived in Rust by the same pure function the local reader uses, so the
 * two can never disagree about which directory to look in.
 */
export async function listClaudeSessionsSsh(
  target: { host: string; user?: string | null; port?: number | null },
  cwd: string,
): Promise<string[]> {
  return tauriInvoke<string[]>("list_claude_sessions_ssh", { target, cwd });
}

/** The newest assistant line of a transcript on another machine — for a dormant card's preview. */
export async function readClaudeSessionTailSsh(
  target: { host: string; user?: string | null; port?: number | null },
  cwd: string,
  sessionId: string,
  maxChars = 240,
): Promise<string | null> {
  return tauriInvoke<string | null>("read_claude_session_tail_ssh", {
    target,
    cwd,
    sessionId,
    maxChars,
  });
}

export async function listClaudeSessions(cwd: string): Promise<string[]> {
  if (!isTauri()) return [];
  try {
    return await tauriInvoke<string[]>("list_claude_sessions", { cwd });
  } catch (err) {
    console.warn("[canvas] list_claude_sessions unavailable (rebuild the app to enable it):", err);
    return [];
  }
}

async function getCurrentTauriWindow() {
  if (!isTauri()) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** This window's label (e.g. `main`); `null` outside Tauri. */
export async function currentWindowLabel(): Promise<string | null> {
  const window = await getCurrentTauriWindow();
  return window?.label ?? null;
}

export async function startCurrentWindowDragging(): Promise<void> {
  const window = await getCurrentTauriWindow();
  await window?.startDragging();
}

export async function toggleCurrentWindowMaximize(): Promise<void> {
  const window = await getCurrentTauriWindow();
  await window?.toggleMaximize();
}

export async function minimizeCurrentWindow(): Promise<void> {
  const window = await getCurrentTauriWindow();
  await window?.minimize();
}

export async function closeCurrentWindow(): Promise<void> {
  const window = await getCurrentTauriWindow();
  await window?.close();
}

export async function isCurrentWindowMaximized(): Promise<boolean> {
  const window = await getCurrentTauriWindow();
  return window ? window.isMaximized() : false;
}

export async function setCurrentWindowTitle(title: string): Promise<void> {
  const nextTitle = title.trim() || "Lotus";
  if (typeof document !== "undefined") {
    document.title = nextTitle;
  }

  const window = await getCurrentTauriWindow();
  await window?.setTitle(nextTitle);
}

export type McpFleetMemberPayload = {
  pane_id: string;
  /**
   * Readable address for this cell (`claude-2`) — what one agent calls another instead of
   * quoting a pane UUID. Already a field on the Rust `McpFleetMember` and already consulted
   * by `fleet_target_matches`; it was simply never filled from this side, so every codespace
   * cell reached `lotus_list_fleet` anonymous. Absent when the host cannot name it.
   */
  agent_address?: string;
  /** Recognition tokens for the same cell (custom name, display name, short pane id). */
  aliases?: string[];
  /** Addresses this cell answered to before its provider was re-detected. */
  legacy_aliases?: string[];
  workspace_id: string;
  cwd: string;
  provider: string;
  /**
   * The runner name as this window prints it (`Claude Code`, `acme`). Absent when the
   * host cannot name it — `provider` stays the machine-readable answer, this is the human
   * one, and they differ for every custom Claude-family runner.
   */
  runner_label?: string;
  display_name: string;
  status: string;
  is_alive: boolean;
  last_output_preview?: string;
  /**
   * What this agent was asked to do — its card headline.
   *
   * The one field that says what a peer is WORKING ON rather than what state it is in.
   * `last_output_preview` is a raw terminal tail and answers a different question. Absent when the
   * agent has not been asked anything this host saw.
   */
  headline?: string;
  session_id?: string | null;
  surface?: "codespace" | "swarm" | "canvas";
  runtime_id?: string;
  team_id?: string;
  member_id?: string;
  address?: string;
  workspace_label?: string;
  fleet_schema_version?: number;
  /** Phase 4 capability truth — lets a lead agent route by what a peer can actually do. */
  can_reply?: boolean;
  can_queue?: boolean;
  mcp_tools_available?: boolean;
  /**
   * Whether this cell's CLI drives the hook pipeline Chat's transcript is made of.
   *
   * Reported rather than read off `provider`, which collapses a custom Claude-family
   * runner to `claude` on purpose and is also what an unreported runner falls back to.
   * Absent means the frontend cannot say.
   */
  reports_steps?: boolean;
  /**
   * Whether this cell asks before acting, derived at the source from the command
   * that launched it (ADR-8). Absent means unknown, never ungated.
   */
  gating?: "asks" | "skipped" | "runner_cannot";
};

export async function bridgePushFleetSnapshot(
  fleet: McpFleetMemberPayload[],
  activeWorkspaceId?: string | null,
): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke("bridge_push_fleet_snapshot", { fleet, activeWorkspaceId });
}

export async function bridgePushCanvasFleetSnapshot(fleet: McpFleetMemberPayload[]): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke("bridge_push_canvas_fleet_snapshot", { fleet });
}

/**
 * Tells Rust a canvas pane was CLOSED, as opposed to merely switched away from.
 *
 * Rust keeps a pane in the fleet after its board stops mentioning it, because a
 * canvas board only ever holds the project on screen and its agents keep running
 * behind it — that is what made a switched-away project read as `no agents` on
 * Lotus Pocket. The two events look identical from Rust until the PTY session
 * ends, and a session can outlive its pane, so only the UI can tell them apart.
 */
export async function bridgeForgetCanvasCell(paneId: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke("bridge_forget_canvas_cell", { paneId });
}

/**
 * One pane's hook-reported turn state (`plans/honest-agent-status/`).
 *
 * `turn` carries the canonical strings from `scripts/agent-notify/event-mapping.mjs` — `idle`,
 * `running`, `needs-input`, `error`, `ended` — verbatim. Deliberately typed as `string`, not a
 * union: this is a wire value produced by a hook script and clamped by Rust, so a value this
 * build has never heard of must arrive intact and be ignored by the resolver, not rejected at
 * the boundary.
 *
 * **Not the same thing as a fleet `status`.** `status` is launch phase ("this pane exists and is
 * running"); `turn` is turn phase ("this agent is waiting for a human"). They share answer
 * strings and answer different questions — `contract/README.md` is the authority.
 */
export type PaneTurnSnapshot = {
  paneId: string;
  turn: string;
  /** Age of the fact in ms, measured by Rust against the hook's own timestamp. */
  turnAgeMs: number;
};

/**
 * Cold hydrate: the turn state Rust already holds for these panes.
 *
 * Pass each pane's `LOTUS_PANE_ID` — for canvas agents that is
 * `canvasRuntimePaneId(projectId, nodeId)`, which is what `AgentStatusSnapshot.hookPaneId`
 * carries — never a bare node id. The Rust store is keyed by what the hook actually exported,
 * so a mismatch returns an empty list rather than an error.
 *
 * Panes with no recorded fact are **omitted**, never defaulted. An absent entry means "no hook
 * has fired for this pane", which the caller must be able to tell apart from any status value.
 */
export async function canvasPaneTurns(paneIds: string[]): Promise<PaneTurnSnapshot[]> {
  if (!isTauri() || paneIds.length === 0) return [];
  return (await tauriInvoke("canvas_pane_turns", { paneIds })) as PaneTurnSnapshot[];
}

/** A live turn fact as Rust pushes it. `atMs` is the hook's timestamp, not a receipt time. */
export type PaneTurnEvent = { paneId: string; turn: string; atMs: number };

/**
 * Follow `mcp://pane-turn`: Rust emits one per `record_hook_turn`, which is the single choke
 * point both hook producers pass through (the `/v1/hook/stop` curl and the drop-file watcher).
 *
 * Shaped after `defaultSubscribeAgentStopped` in `useAgentDoneCallouts.ts` — a silent no-op
 * outside Tauri, so the canvas renders in a browser test with no turn facts rather than throwing.
 */
export function subscribeCanvasPaneTurn(onTurn: (event: PaneTurnEvent) => void): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<PaneTurnEvent>("mcp://pane-turn", (event) => {
        if (event.payload?.paneId) onTurn(event.payload);
      });
      // Never call the handle directly, even here where it was just created: what `listen`
      // resolves to is an ASYNC function, so a registry entry that is already gone comes back as
      // a rejected promise rather than as a throw — the try/catch around this block cannot see
      // it, and it reaches the window as an unhandled rejection. Canvas showed it as a full
      // runtime error overlay on 2026-09-20.
      if (cancelled) safeTauriUnlisten(off);
      else unlisten = off;
    } catch {
      /* event bridge unavailable — the cold hydrate remains the only source. */
    }
  })();
  return () => {
    cancelled = true;
    safeTauriUnlisten(unlisten);
  };
}

/**
 * Swarm surface pushes its active team members here. MCP combines this with
 * CodeSpace/Canvas fleet snapshots and callers filter by workspace/surface/team.
 * Pass an empty array when closing the Team Terminal to remove Swarm entries.
 */
export async function bridgePushSwarmFleetSnapshot(fleet: McpFleetMemberPayload[]): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke("bridge_push_swarm_fleet_snapshot", { fleet });
}

/**
 * Tell Rust which canvas project this window has mounted (`null` on unmount). A note write from an
 * agent for that project is then routed through this window's editor, not the store (ADR-0047).
 */
export async function notesBridgeSetCanvas(projectId: string | null): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke("notes_bridge_set_canvas", { projectId });
}

export async function bridgeResolveMcpRequest(args: {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}): Promise<boolean> {
  if (!isTauri()) return false;
  return tauriInvoke<boolean>("bridge_resolve_mcp_request", {
    requestId: args.requestId,
    ok: args.ok,
    data: args.data ?? null,
    error: args.error ?? null,
  });
}

/** An agent CLI the canvas can launch, as detected on this machine (ADR-0026 Fase B "Rescan"). */
export interface DetectedCli {
  id: string;
  name: string;
  command: string;
  path: string | null;
  installed: boolean;
  /** The user located this binary by hand (Settings › Agents › Locate…). */
  located?: boolean;
}

/** Point a known CLI at a binary detection missed, or forget that with `null`. Throws the reason. */
export async function setCliPath(id: string, path: string | null): Promise<void> {
  await tauriInvoke<void>("set_cli_path", { id, path });
}

/** Auto-detect installed agent CLIs (Claude/Codex/Cursor). Empty outside the desktop app, or when
 *  the running binary predates this command (a stale dev/release build that needs a rebuild) — we
 *  degrade to "no CLIs" rather than surfacing a Tauri "command not found" runtime error. */
export async function detectInstalledClis(): Promise<DetectedCli[]> {
  if (!isTauri()) return [];
  try {
    return await tauriInvoke<DetectedCli[]>("detect_installed_clis", {});
  } catch (err) {
    console.warn("[canvas] detect_installed_clis unavailable (rebuild the app to enable it):", err);
    return [];
  }
}

// ─── Runner Registry (ADR-0027 Phase 2) ─────────────────────────────────────

/** Per-runner configuration (ADR-0027 Phase 2) */
export interface RunnerConfig {
  id: string;
  skip_permissions: boolean;
  extra_flags: string;
  /** Whether a reopened live agent resumes its prior session (ADR-0027 Phase 5). Default true. */
  resume_on_reopen: boolean;
  resume_session_id?: string;
  /** User-defined custom runner (not an auto-detected CLI). When true, `name` + `command` are used. */
  custom?: boolean;
  /** Display name for a custom runner (e.g. "acme"). */
  name?: string;
  /** Full base command for a custom runner (e.g. "ccs acme --dangerously-skip-permissions"). */
  command?: string;
  /** A custom runner that is actually Claude Code (a 2nd-account/profile wrapper). Grants full
   * claude-family treatment: --append-system-prompt (identity + peer messaging), --model, session. */
  claude_family?: boolean;
  /** `{id}` template for continuing a conversation, e.g. `--resume {id}` (Session Widget, Slice 06). */
  resume_template?: string | null;
  /** `{id}` template for starting one under an id we choose, e.g. `--session-id {id}`. */
  new_session_template?: string | null;
}

/** Detected CLI + loaded configuration merged */
export interface RunnerInfo {
  id: string;
  name: string;
  installed: boolean;
  /** The user located this binary by hand (Settings › Agents › Locate…). */
  located?: boolean;
  path: string | null;
  command: string;
  skip_permissions: boolean;
  extra_flags: string;
  resume_on_reopen: boolean;
  resume_session_id?: string;
  /** True for user-defined custom runners (vs auto-detected CLIs) — the UI shows edit/delete. */
  custom?: boolean;
  /** A custom runner that is actually Claude Code — enables agent-to-agent collaboration + model + resume. */
  claude_family?: boolean;
  /**
   * How this runner is told to continue a conversation, as a template containing `{id}` — e.g.
   * `--resume {id}` (grok) or `--session {id}` (opencode). Session Widget, Slice 06.
   *
   * `resume_on_reopen` is the permission; this is the method. Without it the permission has nothing
   * to act on, which is why custom runners could never resume however that toggle was set.
   */
  resume_template?: string;
  /** Template for starting a conversation under an id we choose, e.g. `--session-id {id}` (grok). */
  new_session_template?: string;
}

/** All runners with their current configs */
export interface RunnerRegistry {
  runners: RunnerInfo[];
}

/** List all installed runners with their persisted configs */
export async function listRunners(): Promise<RunnerRegistry> {
  if (!isTauri()) return { runners: [] };
  try {
    return await tauriInvoke<RunnerRegistry>("list_runners", {});
  } catch (err) {
    console.warn("[runners] list_runners failed:", err);
    return { runners: [] };
  }
}

/** Get a single runner's config by ID */
export async function getRunner(id: string): Promise<RunnerInfo | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<RunnerInfo | null>("get_runner", { id });
  } catch (err) {
    console.warn(`[runners] get_runner(${id}) failed:`, err);
    return null;
  }
}

/** Save runner configuration (skip_permissions, extra_flags, resume_session_id) */
export async function saveRunnerConfig(id: string, config: RunnerConfig): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>("save_runner_config", { id, config });
  } catch (err) {
    console.warn(`[runners] save_runner_config(${id}) failed:`, err);
  }
}

/** Delete a runner's persisted configuration */
export async function deleteRunnerConfig(id: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>("delete_runner_config", { id });
  } catch (err) {
    console.warn(`[runners] delete_runner_config(${id}) failed:`, err);
  }
}

// ─── TTS providers (CodeCanvas voice feedback — BYOK) ────────────────────────
//
// Mirrors the Rust `tts_providers` registry (~/.lotus/tts-providers.json, chmod 0600). API keys are
// redacted to "***" over IPC; send "***" back to preserve, "" to clear, a new value to set. The
// cloud synthesis call (`tts_synthesize`) runs in Rust so keys never enter the renderer.

/** A single TTS provider config (wire shape, camelCase from Rust serde). */
export interface TtsProviderConfig {
  id: string;
  name: string;
  /** "browser" | "openai" | "elevenlabs" | "custom" */
  kind: string;
  /** Built-in providers ship with defaults and can't be deleted (only disabled/reconfigured). */
  builtin: boolean;
  enabled: boolean;
  baseUrl?: string;
  /** Redacted to "***" when read; send "***" to preserve the stored key. */
  apiKey?: string;
  model?: string;
  voice?: string;
  speed?: number;
}

/** Spoken-style preset for voice output — shapes both the composed text and the audio delivery.
 *  "jarvis" is the default: a poised, courteous AI-valet register (calm, articulate, quietly warm). */
export type VoiceTone = "jarvis" | "warm" | "formal" | "brisk" | "custom";

/** How long spoken confirmations run (composer word budget). */
export type VoiceVerbosity = "brief" | "normal" | "expressive";

/** Voice OUTPUT preferences (ADR-0031), persisted alongside the TTS registry. */
export interface VoiceOutputSettings {
  /** Master gate: read confirmations aloud after each command. */
  speakReplies: boolean;
  /** Announce when a background (off-viewport) agent finishes a turn. */
  agentDoneCallouts: boolean;
  /** Also announce visible (on-viewport) agent completions. */
  wakeOnFinish: boolean;
  /** Spoken-style preset. Optional for payloads predating the field (Rust defaults to "jarvis"). */
  tone?: VoiceTone;
  /** Free-text delivery instructions — the effective style when tone is "custom". */
  toneInstructions?: string;
  /** Confirmation length. Optional for old payloads (Rust defaults to "normal"). */
  verbosity?: VoiceVerbosity;
  /** Minimum gap (ms) between two spoken "agent finished" callouts for the same agent, absent a
   *  fresh user-submitted turn (ultra-minimal cap). 0 = announce every turn. Optional for old
   *  payloads (Rust defaults to 45000). */
  agentDoneCooldownMs?: number;
  /** How a finished agent is announced. Absent in files that predate it: derived from
   *  `agentDoneCallouts` (on = sound, off = off) — see `agentDoneAlertMode` (Lotus #184). */
  agentDoneAlert?: AgentDoneAlertMode;
  /** Which sound the "sound" alert plays (also Voice's fallback): an id from `AGENT_DONE_SOUNDS`.
   *  Absent = "classic", the original chime. */
  agentDoneSound?: string;
}

/** "voice" says the agent's name, "sound" plays a chime, "off" stays silent. */
export type AgentDoneAlertMode = "voice" | "sound" | "off";

export const DEFAULT_VOICE_OUTPUT: VoiceOutputSettings = {
  speakReplies: true,
  agentDoneCallouts: true,
  wakeOnFinish: false,
  tone: "jarvis",
  verbosity: "normal",
  agentDoneCooldownMs: 45_000,
};

/** The TTS provider registry + the active provider id used by the voice channel. */
export interface TtsProviderRegistry {
  activeProvider: string;
  providers: TtsProviderConfig[];
  /** Voice output preferences (ADR-0031); optional for backward compat with old payloads. */
  output?: VoiceOutputSettings;
}

/** Audio returned by the Rust synth seam: base64 bytes + a MIME type to play. */
export interface TtsSynthesisResult {
  audioBase64: string;
  mime: string;
}

/** Event names broadcast after a voice-provider mutation so other live components (e.g. the canvas NL
 * command bar) re-read the registry instead of holding a stale copy. */
export const STT_PROVIDERS_CHANGED_EVENT = "lotus:stt-providers-changed";
export const TTS_PROVIDERS_CHANGED_EVENT = "lotus:tts-providers-changed";
export const S2S_PROVIDERS_CHANGED_EVENT = "lotus:s2s-providers-changed";
function notifyVoiceProvidersChanged(event: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(event));
}

/** Outside the desktop app there is no registry — degrade to the browser-only default. */
const BROWSER_ONLY_TTS_REGISTRY: TtsProviderRegistry = {
  activeProvider: "browser",
  providers: [{ id: "browser", name: "Browser (Web Speech)", kind: "browser", builtin: true, enabled: true }],
};

/** List all TTS providers (API keys redacted) with the active selection. */
export async function listTtsProviders(): Promise<TtsProviderRegistry> {
  if (!isTauri()) return BROWSER_ONLY_TTS_REGISTRY;
  try {
    return await tauriInvoke<TtsProviderRegistry>("tts_list_providers", {});
  } catch (err) {
    console.warn("[tts] tts_list_providers failed:", err);
    return BROWSER_ONLY_TTS_REGISTRY;
  }
}

/** Get a single TTS provider (API key redacted). */
export async function getTtsProvider(id: string): Promise<TtsProviderConfig | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<TtsProviderConfig | null>("tts_get_provider", { id });
  } catch (err) {
    console.warn(`[tts] tts_get_provider(${id}) failed:`, err);
    return null;
  }
}

/** Upsert a TTS provider. Send apiKey "***" to preserve the stored key, "" to clear it. */
export async function saveTtsProviderConfig(provider: TtsProviderConfig): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("tts_upsert_provider", { provider });
  notifyVoiceProvidersChanged(TTS_PROVIDERS_CHANGED_EVENT);
}

/** Delete a non-builtin TTS provider. */
export async function deleteTtsProviderConfig(id: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("tts_delete_provider", { id });
  notifyVoiceProvidersChanged(TTS_PROVIDERS_CHANGED_EVENT);
}

/** Set the active TTS provider used by the voice channel. */
export async function setActiveTtsProvider(id: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("tts_set_active_provider", { id });
  notifyVoiceProvidersChanged(TTS_PROVIDERS_CHANGED_EVENT);
}

/** Persist the voice OUTPUT preferences (ADR-0031). */
export async function setVoiceOutput(output: VoiceOutputSettings): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("tts_set_output", { output });
  notifyVoiceProvidersChanged(TTS_PROVIDERS_CHANGED_EVENT);
}

/**
 * Synthesize speech via a BYOK cloud provider (the key stays in Rust). Implemented in
 * `tts_providers.rs` for OpenAI / ElevenLabs / custom (OpenAI-compatible) endpoints.
 * The `browser` provider never calls this — it speaks via the Web Speech API in the renderer.
 */
export async function ttsSynthesize(
  providerId: string,
  text: string,
  opts?: { voice?: string; speed?: number; signal?: AbortSignal },
): Promise<TtsSynthesisResult> {
  if (!isTauri()) throw new Error("Cloud TTS requires the desktop app.");
  if (opts?.signal?.aborted) throw new DOMException("TTS synthesis aborted.", "AbortError");
  const requestId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tts:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`;
  let cancelSent = false;
  const cancelNative = () => {
    if (cancelSent) return;
    cancelSent = true;
    void tauriInvoke<boolean>("tts_cancel_synthesis", { requestId }).catch(() => {});
  };
  opts?.signal?.addEventListener("abort", cancelNative, { once: true });
  if (opts?.signal?.aborted) cancelNative();
  try {
    return await tauriInvoke<TtsSynthesisResult>("tts_synthesize", {
      requestId,
      providerId,
      text,
      voice: opts?.voice,
      speed: opts?.speed,
    });
  } finally {
    opts?.signal?.removeEventListener("abort", cancelNative);
  }
}

// ─── STT providers (CodeCanvas voice input — BYOK) ───────────────────────────
//
// Mirrors the Rust `stt_providers` registry (~/.lotus/stt-providers.json, chmod 0600). API keys are
// redacted to "***" over IPC; send "***" back to preserve, "" to clear, a new value to set. The
// cloud transcription call (`stt_transcribe`) runs in Rust so keys never enter the renderer.

/** A single STT provider config (wire shape, camelCase from Rust serde). */
export interface SttProviderConfig {
  id: string;
  name: string;
  /** "browser" | "openai" | "deepgram" | "custom" */
  kind: string;
  builtin: boolean;
  enabled: boolean;
  baseUrl?: string;
  /** Redacted to "***" when read; send "***" to preserve the stored key. */
  apiKey?: string;
  model?: string;
  language?: string;
}

/** The STT provider registry + the active provider id used by the voice-input channel. */
export interface SttProviderRegistry {
  activeProvider: string;
  providers: SttProviderConfig[];
}

/** Provider-neutral decoder context compiled at capture start. */
export interface SttDecoderContext {
  prompt: string;
  keywords: string[];
  languages: string[];
}

/** Transcript returned by the Rust transcribe seam. */
export interface SttTranscriptResult {
  text: string;
  detectedLanguages?: string[];
}

/** Outside the desktop app there is no registry — degrade to the browser-only default. */
const BROWSER_ONLY_STT_REGISTRY: SttProviderRegistry = {
  activeProvider: "browser",
  providers: [{ id: "browser", name: "Browser (Web Speech)", kind: "browser", builtin: true, enabled: true }],
};

/** List all STT providers (API keys redacted) with the active selection. */
export async function listSttProviders(): Promise<SttProviderRegistry> {
  if (!isTauri()) return BROWSER_ONLY_STT_REGISTRY;
  try {
    return await tauriInvoke<SttProviderRegistry>("stt_list_providers", {});
  } catch (err) {
    console.warn("[stt] stt_list_providers failed:", err);
    return BROWSER_ONLY_STT_REGISTRY;
  }
}

/** Get a single STT provider (API key redacted). */
export async function getSttProvider(id: string): Promise<SttProviderConfig | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<SttProviderConfig | null>("stt_get_provider", { id });
  } catch (err) {
    console.warn(`[stt] stt_get_provider(${id}) failed:`, err);
    return null;
  }
}

/** Upsert an STT provider. Send apiKey "***" to preserve the stored key, "" to clear it. */
export async function saveSttProviderConfig(provider: SttProviderConfig): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("stt_upsert_provider", { provider });
  notifyVoiceProvidersChanged(STT_PROVIDERS_CHANGED_EVENT);
}

/** Delete a non-builtin STT provider. */
export async function deleteSttProviderConfig(id: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("stt_delete_provider", { id });
  notifyVoiceProvidersChanged(STT_PROVIDERS_CHANGED_EVENT);
}

/** Set the active STT provider used by the voice-input channel. */
export async function setActiveSttProvider(id: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("stt_set_active_provider", { id });
  notifyVoiceProvidersChanged(STT_PROVIDERS_CHANGED_EVENT);
}

// ── Voice-to-Voice (S2S) provider registry (opt-in duplex mode — BYOK) ─────────

/** On-disk shape of a realtime speech-to-speech provider (see `s2s_providers.rs`). */
export interface S2sProviderConfig {
  id: string;
  name: string;
  /** "grok" | "openai-realtime" | "custom" (all OpenAI-Realtime-compatible). */
  kind: string;
  builtin: boolean;
  enabled: boolean;
  /** Realtime WebSocket endpoint, e.g. "wss://api.x.ai/v1/realtime". */
  baseUrl?: string;
  /** Redacted to "***" when read; send "***" to preserve the stored key. */
  apiKey?: string;
  model?: string;
  voice?: string;
}

/** The S2S provider registry + the active provider id used by the voice-to-voice channel. */
export interface S2sProviderRegistry {
  activeProvider: string;
  providers: S2sProviderConfig[];
}

/** Outside the desktop app there is no S2S registry — the duplex mode is desktop-only. */
const EMPTY_S2S_REGISTRY: S2sProviderRegistry = { activeProvider: "grok", providers: [] };

/** List all S2S providers (API keys redacted) with the active selection. */
export async function listS2sProviders(): Promise<S2sProviderRegistry> {
  if (!isTauri()) return EMPTY_S2S_REGISTRY;
  try {
    return await tauriInvoke<S2sProviderRegistry>("s2s_list_providers", {});
  } catch (err) {
    console.warn("[s2s] s2s_list_providers failed:", err);
    return EMPTY_S2S_REGISTRY;
  }
}

/** Get a single S2S provider (API key redacted). */
export async function getS2sProvider(id: string): Promise<S2sProviderConfig | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<S2sProviderConfig | null>("s2s_get_provider", { id });
  } catch (err) {
    console.warn(`[s2s] s2s_get_provider(${id}) failed:`, err);
    return null;
  }
}

/** Upsert an S2S provider. Send apiKey "***" to preserve the stored key, "" to clear it. */
export async function saveS2sProviderConfig(provider: S2sProviderConfig): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("s2s_upsert_provider", { provider });
  notifyVoiceProvidersChanged(S2S_PROVIDERS_CHANGED_EVENT);
}

/** Delete a non-builtin S2S provider. */
export async function deleteS2sProviderConfig(id: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("s2s_delete_provider", { id });
  notifyVoiceProvidersChanged(S2S_PROVIDERS_CHANGED_EVENT);
}

/** Set the active S2S provider used by the voice-to-voice channel. */
export async function setActiveS2sProvider(id: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("s2s_set_active_provider", { id });
  notifyVoiceProvidersChanged(S2S_PROVIDERS_CHANGED_EVENT);
}

/**
 * Transcribe recorded audio via a BYOK cloud provider (the key stays in Rust). Implemented in
 * `stt_providers.rs` per provider kind (OpenAI Whisper-compatible, Deepgram, …).
 * The `browser` provider never calls this — it transcribes via the Web Speech API in the renderer.
 */
export async function sttTranscribe(
  providerId: string,
  audioBase64: string,
  mime: string,
  /** Structured prompt, literal keywords, and language hints snapshotted for this turn. */
  context?: SttDecoderContext,
): Promise<SttTranscriptResult> {
  if (!isTauri()) throw new Error("Cloud STT requires the desktop app.");
  return await tauriInvoke<SttTranscriptResult>("stt_transcribe", { providerId, audioBase64, mime, context });
}

/** Streaming STT transcript events from the Deepgram realtime socket (mirrors `stt_stream::StreamEvent`). */
export type SttStreamEvent =
  | { kind: "partial"; transcript: string }
  | { kind: "final"; transcript: string }
  | { kind: "error"; message: string }
  | { kind: "closed" };

/**
 * Open a streaming STT session (Deepgram realtime). Partial + final transcripts arrive on `onEvent`
 * via a Tauri Channel; the API key stays in Rust. Returns the session id for sttStreamSend/Finish/Cancel.
 */
export async function sttStreamStart(
  providerId: string,
  onEvent: (event: SttStreamEvent) => void,
): Promise<string> {
  if (!isTauri()) throw new Error("Streaming STT requires the desktop app.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { invoke, Channel } = (await loadTauriCore()) as any;
  const channel = new Channel();
  channel.onmessage = (event: SttStreamEvent) => onEvent(event);
  return (invoke as (cmd: string, args?: Record<string, unknown>) => Promise<string>)("stt_stream_start", {
    providerId,
    onEvent: channel,
  });
}

/** Forward one base64 PCM16 audio chunk to an open streaming STT session. */
export async function sttStreamSend(sessionId: string, audioBase64: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("stt_stream_send", { sessionId, audioBase64 });
}

/** Flush an open streaming STT session and await its final transcripts. */
export async function sttStreamFinish(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("stt_stream_finish", { sessionId });
}

/** Abort an open streaming STT session without waiting for finals. */
export async function sttStreamCancel(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("stt_stream_cancel", { sessionId });
}

// ─── Voice-to-Voice (S2S) duplex stream (opt-in — BYOK realtime) ────────────────────────────────

/**
 * Events from the realtime voice-to-voice socket (mirrors `s2s_stream::S2sStreamEvent`). Feed these
 * into `reduceS2sSession`: `audioDelta` → enqueue playback; `userSpeechStart`/`userSpeechEnd` and
 * `agentAudioEnd` drive the turn floor; `transcript` is display-only.
 */
export type S2sStreamEvent =
  | { kind: "audioDelta"; audioBase64: string; responseId?: string }
  | { kind: "userSpeechStart" }
  | { kind: "userSpeechEnd" }
  | { kind: "agentAudioEnd" }
  | { kind: "responseDone" }
  | { kind: "transcript"; text: string; isFinal: boolean; speaker?: "user" | "agent" }
  | { kind: "toolCall"; callId: string; name: string; arguments: string }
  | { kind: "error"; message: string }
  | { kind: "closed" };

/**
 * Open a duplex voice-to-voice session against an OpenAI-Realtime-compatible provider (Grok /
 * OpenAI Realtime). Audio deltas + turn events arrive on `onEvent` via a Tauri Channel; the API key
 * stays in Rust. Returns the session id for s2sStreamSend/Interrupt/Close.
 */
export async function s2sStreamStart(
  providerId: string,
  onEvent: (event: S2sStreamEvent) => void,
  instructions?: string,
  /** JSON string of the realtime `tools` array (concierge tools) to advertise in session.update. */
  tools?: string,
): Promise<string> {
  if (!isTauri()) throw new Error("Voice-to-voice requires the desktop app.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { invoke, Channel } = (await loadTauriCore()) as any;
  const channel = new Channel();
  channel.onmessage = (event: S2sStreamEvent) => onEvent(event);
  return (invoke as (cmd: string, args?: Record<string, unknown>) => Promise<string>)("s2s_stream_start", {
    providerId,
    instructions,
    tools,
    onEvent: channel,
  });
}

/** Forward one base64 PCM16 mic chunk to an open voice-to-voice session. */
export async function s2sStreamSend(sessionId: string, audioBase64: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("s2s_stream_send", { sessionId, audioBase64 });
}

/** Sanitized native queue/backpressure counters for an open voice-to-voice stream. */
export interface S2sStreamDiagnostics {
  queueCapacity: number;
  queueAvailable: number;
  queueUsed: number;
  enqueuedAudioChunks: number;
  droppedAudioChunks: number;
  forwardedAudioChunks: number;
}

/** Snapshot native S2S audio-send backpressure diagnostics. No audio/transcript/secrets are returned. */
export async function s2sStreamDiagnostics(sessionId: string): Promise<S2sStreamDiagnostics | null> {
  if (!isTauri()) return null;
  return await tauriInvoke<S2sStreamDiagnostics>("s2s_stream_diagnostics", { sessionId });
}

/** Barge-in: cancel the model's in-flight response so the user can interrupt. */
export async function s2sStreamInterrupt(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("s2s_stream_interrupt", { sessionId });
}

/**
 * Barge-in follow-up: tell the provider how much of the assistant item the user ACTUALLY heard, so its
 * context drops the unheard tail (`conversation.item.truncate`). Without this the model keeps sentences
 * the user never heard and later refers back to things it never said. Always paired with — and sent
 * after — {@link s2sStreamInterrupt}. `audioEndMs` must never exceed the item's real audio duration.
 */
export async function s2sStreamTruncate(
  sessionId: string,
  itemId: string,
  audioEndMs: number,
): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("s2s_stream_truncate", { sessionId, itemId, audioEndMs });
}

/** Send one realtime function result. Only the final item in a batch continues the response. */
export async function s2sStreamToolResult(
  sessionId: string,
  callId: string,
  output: string,
  continueResponse = true,
): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("s2s_stream_tool_result", {
    sessionId,
    callId,
    output,
    continueResponse,
  });
}

/** Refresh realtime voice session instructions/tools without restarting mic/audio. */
export async function s2sStreamUpdate(sessionId: string, instructions?: string, tools?: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("s2s_stream_update", { sessionId, instructions, tools });
}

/** Close an open voice-to-voice session. */
export async function s2sStreamClose(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("s2s_stream_close", { sessionId });
}

/** Echo a renderer-side voice-to-voice diagnostic to the Rust dev terminal (only printed when
 *  `LOTUS_S2S_DEBUG` is set on the Rust side). Fire-and-forget; never throws. */
export async function s2sDebugLog(line: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>("s2s_debug_log", { line });
  } catch {
    /* diagnostics must never break playback */
  }
}

// ─── Music node (CodeCanvas YouTube player) ────────────────────────────────────────────────────
/** Track metadata resolved from YouTube oEmbed (keyless; resolved in Rust — no CORS in the webview). */
export interface MusicTrackMeta {
  title: string;
  author: string;
  thumbnailUrl: string;
}

/**
 * Resolve title/author/thumbnail for a pasted YouTube URL. Rejects with a
 * user-presentable message (video private/deleted, embedding disallowed, offline).
 */
export async function musicResolveTrack(url: string): Promise<MusicTrackMeta> {
  if (!isTauri()) throw new Error("music_resolve_track is only available in the desktop app");
  return await tauriInvoke<MusicTrackMeta>("music_resolve_track", { url });
}

/**
 * Local HTTP wrapper URL for production desktop YouTube playback. `startSec` is the
 * resume position baked into this load (the engine keeps it fixed per load so the
 * URL — and therefore the player — is not rebuilt on every time tick).
 */
export async function musicYoutubePlayerUrl(videoId: string, autoplay: boolean, startSec?: number): Promise<string> {
  if (!isTauri()) throw new Error("music_youtube_player_url is only available in the desktop app");
  const start = typeof startSec === "number" && Number.isFinite(startSec) && startSec > 0
    ? Math.floor(startSec)
    : undefined;
  return await tauriInvoke<string>("music_youtube_player_url", { videoId, autoplay, startSec: start });
}

// ─── NL utility completion (W1c) ────────────────────────────────────────────────────────────────
/** Mute the Mac's sound output while dictating, and put it back after. Best effort: never throws. */
export async function setOtherAudioMuted(on: boolean): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke("voice_mute_other_audio", { on }).catch(() => {});
}

/** Play an Agent-Done Alert sound natively (macOS). Rejects where it can't; callers fall back to `<audio>`. */
export async function playAgentDoneSoundNative(id: string): Promise<void> {
  if (!isTauri()) throw new Error("native agent-done sound needs the desktop app");
  await tauriInvoke("voice_play_agent_done_sound", { id });
}

/**
 * One NL utility completion (parse / dispatch-refine / dictation polish) over a direct Anthropic
 * Messages HTTP call in Rust, keyed by the BYOK key on the model registry's Anthropic provider (the
 * key never enters the renderer). ~sub-second vs the multi-second cold `claude --print` spawn.
 *
 * Rejects FAST when no key is configured (no HTTP attempted) or on any HTTP failure, so callers can
 * transparently fall back to the CLI model path — behavior is unchanged for users without a key.
 */
export async function nlComplete(
  prompt: string,
  schema?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (!isTauri()) throw new Error("nl_complete is only available in the desktop app");
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const cancelNative = () => {
    void tauriInvoke<void>("nl_cancel", { requestId }).catch(() => {});
  };
  signal?.addEventListener("abort", cancelNative, { once: true });
  try {
    const result = await tauriInvoke<string>("nl_complete", { prompt, schema, requestId });
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", cancelNative);
  }
}

/** BYOK NL model config (dedicated store ~/.lotus/nl-model.json). Key returns redacted as "***". */
export interface NlModelConfig {
  /** "openai" | "anthropic" | "" (unset → CLI fallback). */
  provider: string;
  apiKey?: string;
  /** Model id override; defaults per provider (gpt-4o-mini / claude-haiku-4-5). */
  model?: string;
  /** Base URL override (proxy / openai-compat); defaults to the public host. */
  baseUrl?: string;
}

/** Read the NL model config (key redacted). Empty config outside Tauri. */
export async function getNlModelConfig(): Promise<NlModelConfig> {
  if (!isTauri()) return { provider: "" };
  try {
    return await tauriInvoke<NlModelConfig>("nl_model_get_config", {});
  } catch (err) {
    console.warn("[nl-model] get config failed:", err);
    return { provider: "" };
  }
}

/** Persist the NL model config. Send apiKey "***" to keep the stored key, "" to clear it. */
export async function setNlModelConfig(config: NlModelConfig): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("nl_model_set_config", { config });
}
