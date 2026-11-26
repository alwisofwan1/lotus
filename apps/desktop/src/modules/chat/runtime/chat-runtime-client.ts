// Calls into the Rust chat runtime (src-tauri/src/chat_runtime). Events arrive on a Tauri
// Channel and are validated here: this is where data from outside the webview enters the module.
//
// Reconnect: a subscription replays every stored event after `afterSeq`, then streams new ones.
// After a reload, subscribe again with the `lastSeq` of the state you kept; nothing is missed or
// applied twice (`applyThreadEvent` ignores old seqs).

import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { loadTauriCore } from "@/lib/tauri/runtime";

import type { EditorFileIndex, EditorListEntry, EditorReadFileResult, EditorWriteFileResult } from "@/lib/tauri/codespace";

import type { Changes } from "../domain/changes";
import { claudeSlashItems, codexSlashItems, type ClaudeCommand, type CodexSkill, type SlashItem } from "../domain/slash";
import { threadEventEnvelopeSchema, type Attachment, type ThreadEventEnvelope } from "../domain/thread-event";
import type { AcpRunner } from "../providers/acp/agents";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Which agent runs a thread (#286); picked at New chat and fixed for the thread.
 *  "api": an OpenAI-compatible provider from Settings › Chat › Accounts, text only (#288). */
export type Runner = "claude" | "codex" | "api" | AcpRunner;

export interface ChatThread {
  id: string;
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
  runner: Runner;
  /** The "api" thread's model-registry provider; null for the other runners. */
  provider: string | null;
  effort: string | null;
  providerSessionId: string | null;
  /** The ccs Claude account it runs on; null = the one picked in the usage popover, else the default login. */
  account: string | null;
  createdAt: number;
  updatedAt: number;
  /** The first line of the first message (#287); null until one is sent. */
  title: string | null;
  /** The CodeChat session it was imported from (#290); null for chats made here. */
  importedFrom: string | null;
  /** In the rail's Archived drawer (#291). */
  archived: boolean;
  /** When it was pinned to the top of the rail; null = not pinned (plans/chat-thread-pin). */
  pinnedAt: number | null;
  /** When its last turn ended, and when it was last opened (Command Rail); null = never. */
  lastTurnEndedAt: number | null;
  lastReadAt: number | null;
  /** When the running turn started; null while none runs in this Lotus run. */
  turnStartedAt: number | null;
  /** What it is doing in this Lotus run: working on a turn, or waiting for the user. */
  status: "working" | "waiting" | null;
  /** The chat that delegated it (lotus_chat_delegate); null for a chat the user started. */
  parentId: string | null;
  /** The SSH machine whose Lotus Host runs it (plans/chat-remote-host); null/absent = this Mac. */
  machine?: RemoteMachine | null;
  /** A remote chat's stream trouble in this Lotus run; null = fine (or a local chat). */
  link?: "reconnecting" | "down" | null;
  /** Its agent's Agent Handle (ADR-0068); null until the chat is first opened. */
  agentName?: string | null;
}

/** One project a machine's Lotus Host holds; `id` is what a remote chat runs in. */
export interface HostProject {
  id: string;
  name: string;
  path: string;
}

export type MachineTarget = { host: string; user?: string | null; port?: number | null };

/** The projects `target`'s Lotus Host holds (opens the machine's host link on first use). */
export function listMachineProjects(target: MachineTarget): Promise<HostProject[]> {
  return call("machine_host_projects", { target: { host: target.host, user: target.user ?? null, port: target.port ?? null } });
}

export interface HostFolder { name: string; path: string; isRepo: boolean; isProject: boolean }
/** `GET /api/fs` on a machine's host: its roots, and one folder level when `path` is given. */
export interface HostBrowse {
  roots: { name: string; path: string }[];
  page: { path: string; parent: string | null; entries: HostFolder[] } | null;
}

const wire = (target: MachineTarget) => ({ host: target.host, user: target.user ?? null, port: target.port ?? null });

/** One folder level on that machine, limited to the folders its Lotus Host lets anyone see. */
export function browseMachine(target: MachineTarget, path: string | null): Promise<HostBrowse> {
  return call("machine_host_browse", { target: wire(target), path });
}

/** Make a folder on that machine one of its host's projects, so a chat can start there. */
export function addMachineProject(target: MachineTarget, path: string): Promise<HostProject> {
  return call("machine_host_add_project", { target: wire(target), path });
}

/** Reconnect a remote chat's stream now instead of waiting out the backoff. */
export function retryRemoteChat(threadId: string): Promise<void> {
  return call("chat_remote_retry", { threadId });
}

export interface RemoteMachine {
  host: string;
  user: string | null;
  port: number | null;
  /** The host's project the agent runs in. */
  workspaceId: string;
  /** The host's headless cell, once the first message started it. */
  paneId: string | null;
  /** The last stream id read (`<bootId>:<cursor>`). */
  cursor: string | null;
}

// `answers` answers a question: question text → chosen labels joined with ", ", or the user's words.
// `remember` keeps the Allow for the rest of the session, where the request offers it.
export type ApprovalDecision = { behavior: "allow"; answers?: Record<string, string>; remember?: boolean } | { behavior: "deny"; message: string };

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await loadTauriCore();
  return invoke<T>(command, args);
}

export function createChatThread(input: {
  cwd: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  runner?: Runner;
  effort?: string | null;
  provider?: string | null;
  /** The new-chat screen's id, so files pasted there are already in the chat's folder. */
  id?: string | null;
}): Promise<ChatThread> {
  return call("chat_thread_create", {
    cwd: input.cwd,
    model: input.model ?? null,
    permissionMode: input.permissionMode ?? null,
    runner: input.runner ?? null,
    effort: input.effort ?? null,
    provider: input.provider ?? null,
    id: input.id ?? null,
  });
}

/** A chat whose agent runs in the Lotus Host on `machine`; `cwd` is the project's path there. */
export function createRemoteChatThread(input: {
  machine: Pick<RemoteMachine, "host" | "user" | "port" | "workspaceId">;
  cwd: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  runner?: "claude" | "codex";
  effort?: string | null;
  id?: string | null;
}): Promise<ChatThread> {
  return call("chat_thread_create_remote", {
    machine: { ...input.machine, paneId: null, cursor: null },
    cwd: input.cwd,
    model: input.model ?? null,
    permissionMode: input.permissionMode ?? null,
    runner: input.runner ?? null,
    effort: input.effort ?? null,
    id: input.id ?? null,
  });
}

/** Called when a thread may have moved in the rail (a turn started or ended, an approval asked or
 *  answered). Returns the stop; a stop before `listen` resolves still unlistens. */
export function onChatRailChange(handler: () => void): () => void {
  const pending = import("@tauri-apps/api/event").then(({ listen }) => listen("chat://rail-changed", handler));
  // One release path only: a second unlisten of the same id throws `listeners[eventId].handlerId`
  // inside Tauri's script, as an unhandled rejection (a stop before `listen` resolved used to do both).
  return () => void pending.then(safeTauriUnlisten, () => {});
}

export function listChatThreads(): Promise<ChatThread[]> {
  return call("chat_threads_list");
}

/** Renames a thread (#291); an empty name goes back to its first message's line. */
export function renameChatThread(threadId: string, title: string): Promise<void> {
  return call("chat_thread_rename", { threadId, title });
}

/** The chat's Agent Handle; the agent hears it with the next message. */
export function setChatAgentName(threadId: string, name: string): Promise<void> {
  return call("chat_thread_set_agent_name", { threadId, name });
}

/** The thread menu's "Regenerate title": a new title from the whole chat; it replaces a rename too. */
/** Locks a chat to the app's approvals: its session loads no user/project settings. One way. */
export function setChatStrictPermissions(threadId: string): Promise<void> {
  return call("chat_thread_set_strict_permissions", { threadId });
}

/** Starts the thread's agent process ahead of the first message. */
export function warmChatThread(threadId: string): Promise<void> {
  return call("chat_thread_warm", { threadId });
}

export function regenerateChatTitle(threadId: string): Promise<string> {
  return call("chat_thread_regenerate_title", { threadId });
}

/** The first message of a new chat that continues `threadId` in the `to` runner (handoff). */
export function chatHandoffSeed(threadId: string, to: Runner): Promise<string> {
  return call("chat_handoff_seed", { threadId, to });
}

export function archiveChatThread(threadId: string, archived: boolean): Promise<void> {
  return call("chat_thread_archive", { threadId, archived });
}

/** Pins a thread to the top of the rail, or unpins it. Archiving unpins too. */
export function pinChatThread(threadId: string, pinned: boolean): Promise<void> {
  return call("chat_thread_pin", { threadId, pinned });
}

/** Opening a thread, or watching it while a turn ends, reads its news (Command Rail). */
export function markChatThreadRead(threadId: string): Promise<void> {
  return call("chat_thread_mark_read", { threadId });
}

/** Stops a running turn, then deletes the thread's history. Its folder is never touched. */
export function deleteChatThread(threadId: string): Promise<void> {
  return call("chat_thread_delete", { threadId });
}

/** CodeChat chats not imported yet, and how many this call imported (0 on a dry run). */
export interface CodeChatImport {
  pending: number;
  imported: number;
}

/** Settings' "Import CodeChat history" (#290); `dryRun` only counts. Safe to repeat. */
export function importCodeChatHistory(dryRun: boolean): Promise<CodeChatImport> {
  return call("chat_import_codechat", { dryRun });
}

/** Turns finished since `since` (ms), across every thread. */
export interface ChatStats {
  turns: number;
  durationMs: number;
  tokens: number;
}

export function getChatStats(since: number): Promise<ChatStats> {
  return call("chat_stats", { since });
}

// Starts a turn, or steers the running one.
export function sendChatMessage(
  threadId: string,
  text: string,
  clientRequestId: string = crypto.randomUUID(),
  attachments: readonly Attachment[] = [],
): Promise<void> {
  return call("chat_send", { threadId, text, clientRequestId, attachments });
}

/** Copies one attachment to a remote chat's machine; the answer names where it is there (ADR-0069).
 *  `onProgress` gets whole percents while the bytes go out. */
export async function uploadAttachment(threadId: string, attachment: Attachment, onProgress?: (percent: number) => void): Promise<Attachment> {
  const { invoke, Channel } = await loadTauriCore();
  const progress = new Channel<number>();
  if (onProgress) progress.onmessage = onProgress;
  return invoke<Attachment>("chat_attachment_upload", { threadId, attachment, progress });
}

/** Saves pasted content, which has no file of its own, as an attachment of `threadId` (#279). */
export async function savePastedAttachment(threadId: string, file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the pasted file"));
    reader.readAsDataURL(file);
  });
  return call("chat_attachment_save_pasted", {
    threadId,
    name: file.name || "pasted",
    mimeType: file.type || null,
    dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
  });
}

/** A data URL for an image attachment's thumbnail; rejects when the file is gone. */
export function attachmentPreview(path: string): Promise<string> {
  return call("chat_attachment_preview", { path });
}

export function interruptChatTurn(threadId: string): Promise<void> {
  return call("chat_interrupt", { threadId });
}

export function stopChatThread(threadId: string): Promise<void> {
  return call("chat_thread_stop", { threadId });
}

export function resolveChatInteraction(threadId: string, interactionId: string, decision: ApprovalDecision): Promise<void> {
  return call("chat_resolve_interaction", { threadId, interactionId, decision });
}

/** One entry of the runner's own model list: Claude's for the current sign-in (#278), or Codex's (#286). */
export interface ChatModel {
  /** What to pick it by: an alias ("opus") or a full id. "default" is Claude's own default. */
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  /** Codex: its default model, the reasoning efforts it takes, and the one it uses unless told. */
  isDefault?: boolean;
  efforts?: string[];
  defaultEffort?: string | null;
  /** "api" runner: which registry provider the model is from (#288). */
  provider?: string;
  providerName?: string;
}

export async function listChatModels(runner: Runner = "claude"): Promise<ChatModel[]> {
  return (await call<{ models: ChatModel[] }>("chat_models_list", { runner })).models;
}

/** What `/` offers in `cwd` for this runner, ready for the picker. */
export async function listSlashItems(runner: Runner, cwd: string): Promise<SlashItem[]> {
  const r = await call<{ commands?: ClaudeCommand[]; skillNames?: string[]; skills?: CodexSkill[] }>("chat_commands_list", { runner, cwd });
  return r.skills ? codexSlashItems(r.skills) : claudeSlashItems(r.commands ?? [], r.skillNames ?? []);
}

/** The model ids an OpenAI-compatible endpoint lists (`GET /models`). `apiKey` "***": the saved key of `providerId`. */
export function fetchApiModels(baseUrl: string, apiKey: string | null, providerId: string | null): Promise<string[]> {
  return call("chat_api_models", { baseUrl, apiKey, providerId });
}

/** Applies from the thread's next message; `label` is what the switch line in the chat says. */
export function setChatModel(threadId: string, model: string, label: string, effort?: string): Promise<void> {
  return call("chat_set_model", { threadId, model, label, effort: effort ?? null });
}

/** Moves a Claude chat to another ccs account; its next message resumes the same session there. */
export function setChatAccount(threadId: string, account: string): Promise<void> {
  return call("chat_set_account", { threadId, account });
}

/** Changes what the agent may do without asking; its next message resumes the session in the new mode. */
export function setChatPermissionMode(threadId: string, mode: PermissionMode, label: string): Promise<void> {
  return call("chat_set_permission_mode", { threadId, mode, label });
}

/** The sign-in new sessions start with (#277). Never carries the key: only its last four characters. */
export interface ChatAuthView {
  mode: "login" | "apiKey";
  keyHint: string | null;
  /** Null: the OS keychain. A path: the plain file a macOS dev build uses instead. */
  storedInFile: string | null;
}

export function getChatAuth(): Promise<ChatAuthView> {
  return call("chat_auth_get");
}

/** Saving a key also switches new sessions to it. */
export function saveChatApiKey(key: string): Promise<ChatAuthView> {
  return call("chat_auth_save_key", { key });
}

export function removeChatApiKey(): Promise<ChatAuthView> {
  return call("chat_auth_remove_key");
}

export function setChatAuthMode(mode: ChatAuthView["mode"]): Promise<ChatAuthView> {
  return call("chat_auth_set_mode", { mode });
}

export interface ChatSubscription {
  threadId: string;
  afterSeq: number;
  onEvent: (envelope: ThreadEventEnvelope) => void;
  /** Called once, after the last stored event (the replay) has reached `onEvent`. */
  onReplayed?: () => void;
}

/**
 * Returns the unsubscribe function. The promise resolving does NOT mean the replay has arrived:
 * channel messages and the command's reply travel separately, so a long history can still be
 * landing over several frames. `onReplayed` is the signal for that; the runtime returns the
 * replay's last seq and this waits until the channel has delivered it.
 */
export async function subscribeChatThread({ threadId, afterSeq, onEvent, onReplayed }: ChatSubscription): Promise<() => void> {
  const { invoke, Channel } = await loadTauriCore();
  const channel = new Channel<unknown>();
  // Highest seq the channel has delivered, counting events skipped below, so one unknown event
  // at the end of the history cannot hold the replay open.
  let delivered = afterSeq;
  let through: number | null = null;
  let replayed = false;
  const settle = () => {
    if (replayed || through === null || delivered < through) return;
    replayed = true;
    onReplayed?.();
  };
  channel.onmessage = (raw) => {
    const parsed = threadEventEnvelopeSchema.safeParse(raw);
    // A newer runtime can send an event kind this build does not know; skip it, keep the rest.
    if (parsed.success) onEvent(parsed.data);
    else console.warn("[chat] dropped an event that does not match the schema", parsed.error.issues);
    const seq = (raw as { seq?: unknown } | null)?.seq;
    if (typeof seq === "number" && seq > delivered) delivered = seq;
    settle();
  };
  const { subscriptionId, replayedThrough } = await invoke<{ subscriptionId: number; replayedThrough: number }>(
    "chat_subscribe",
    { threadId, afterSeq, onEvent: channel },
  );
  through = replayedThrough;
  settle();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    channel.onmessage = () => {};
    void invoke("chat_unsubscribe", { subscriptionId }).catch(() => {});
  };
}

// Workbench Changes (#281): git in the thread's folder, and whose edit is whose.
export function getChatChanges(threadId: string): Promise<Changes> {
  return call("chat_changes", { threadId });
}

// The Files pane (#282) reuses the editor's file commands: they already guard size, encoding and
// a save over a file that changed on disk ("File has changed on disk").

/** Every file in the chat's folder, relative to it; hidden and heavy folders left out. */
export function indexChatFolder(cwd: string): Promise<EditorFileIndex> {
  return call("editor_index_files", { root: cwd });
}

/** One level of any folder on disk, for an `@` typed as a path; hidden entries left out. */
export function listChatPath(dir: string): Promise<EditorListEntry[]> {
  return call("editor_list_entries", { root: dir, maxDepth: 0 });
}

export function homeFolder(): Promise<string> {
  return call("get_homedir");
}

/** `allowLarge` lifts the 10 MB text cap to 50 MB ("Open anyway"). */
export function readChatFile(path: string, allowLarge = false): Promise<EditorReadFileResult> {
  return call("editor_read_file", allowLarge ? { path, allowLarge } : { path });
}

/** Times (ms) and size only, without reading the file; `created` is null where the disk keeps none. */
export function statChatFile(path: string): Promise<{ mtime: number; created: number | null; sizeBytes: number }> {
  return call("editor_stat_file", { path });
}

/** The last `lines` lines of a file too large to read whole; `sizeBytes` is the whole file's. */
export function readChatFileTail(path: string, lines: number): Promise<EditorReadFileResult> {
  return call("editor_read_file_tail", { path, lines });
}

/** Raw bytes for the media viewer (64 MB cap). */
export function readChatFileBytes(path: string): Promise<ArrayBuffer> {
  return call("editor_read_file_bytes", { path });
}

export function openChatFileExternally(cwd: string, path: string): Promise<void> {
  return call("open_path_reference", { path, cwd });
}

export function revealChatFile(cwd: string, path: string): Promise<void> {
  return call("editor_reveal_entry", { root: cwd, relativePath: path });
}

/** A new empty file, or a folder, at a folder-relative path; missing parent folders are made too. */
export function createChatEntry(cwd: string, path: string, folder: boolean): Promise<unknown> {
  return call(folder ? "editor_create_directory" : "editor_create_file", { root: cwd, relativePath: path });
}

export function renameChatEntry(cwd: string, from: string, to: string): Promise<unknown> {
  return call("editor_rename_entry", { root: cwd, fromRelativePath: from, toRelativePath: to });
}

/** Moves a file or folder to the Trash (macOS), where Finder can put it back. */
export function trashChatEntry(cwd: string, path: string): Promise<unknown> {
  return call("editor_trash_entry", { root: cwd, relativePath: path });
}

/** `expectedMtime` makes the save refuse when the file changed since it was read. */
export function writeChatFile(path: string, content: string, expectedMtime: number | undefined, encoding: string | undefined): Promise<EditorWriteFileResult> {
  return call("editor_write_file", { path, content, expectedMtime, encoding });
}

export function getChatChangeDiff(threadId: string, path: string, ignoreWhitespace = false): Promise<string> {
  return call("chat_change_diff", { threadId, path, ignoreWhitespace });
}

/** Commits exactly `paths`; returns the new commit's short id. */
export function commitChatChanges(threadId: string, paths: string[], message: string): Promise<string> {
  return call("chat_changes_commit", { threadId, paths, message });
}

/** Merges a delegated chat's worktree branch into its lead's branch; returns the merge commit. A conflict is aborted. */
/** A new chat holding this one's conversation through `turnId`, nested under it on the rail. */
export function forkChat(threadId: string, turnId: string): Promise<ChatThread> {
  return call("chat_fork", { threadId, turnId });
}

/** Edits a sent message: the chat goes back to just before `turnId`; then send the new text. */
export function rewindChat(threadId: string, turnId: string): Promise<void> {
  return call("chat_rewind", { threadId, turnId });
}

/** Moves a fork that has not worked yet into its own worktree, with the files as at its turn. */
export function forkChatToWorktree(threadId: string): Promise<ChatThread> {
  return call("chat_fork_worktree", { threadId });
}

export function mergeChildChat(threadId: string): Promise<string> {
  return call("chat_merge_child", { threadId });
}

/** Deletes a delegated or forked chat with its worktree and branch, work included; returns the branch. */
export function discardChildChat(threadId: string): Promise<string> {
  return call("chat_child_discard", { threadId });
}

/** Puts `paths` back as they were before the agent's first edit in this chat. */
export function undoChatChanges(threadId: string, paths: string[]): Promise<void> {
  return call("chat_changes_undo", { threadId, paths });
}
