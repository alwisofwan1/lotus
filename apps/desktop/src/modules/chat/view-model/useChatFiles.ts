"use client";

import { useEffect, useState } from "react";

import { editorListEntriesSsh } from "@/lib/tauri/codespace-editor-ssh";
import { indexChatFolder, type RemoteMachine } from "../runtime/chat-runtime-client";

/** How deep, and how many files, a remote chat's folder is listed (one SSH round trip). */
const REMOTE_DEPTH = 6;
const REMOTE_CAP = 5000;

/** A remote chat's folder over SSH, in the local index's shape: files only, relative to `cwd`. */
async function indexRemoteFolder(machine: Pick<RemoteMachine, "host" | "user" | "port">, cwd: string) {
  const entries = await editorListEntriesSsh({ target: { host: machine.host, user: machine.user, port: machine.port }, remoteCwd: cwd }, REMOTE_DEPTH);
  const root = `${cwd.replace(/\/+$/, "")}/`;
  const files = entries.filter((e) => e.kind === "file").map((e) => (e.path.startsWith(root) ? e.path.slice(root.length) : e.path)).sort();
  return { files: files.slice(0, REMOTE_CAP), truncated: files.length > REMOTE_CAP };
}

export interface ChatFolderFiles {
  /** Relative to the chat's folder. */
  files: string[];
  set: ReadonlySet<string>;
  truncated: boolean;
  error: string | null;
}

const EMPTY: ChatFolderFiles = { files: [], set: new Set(), truncated: false, error: null };

/** The chat folder's files (#282), read again when `refreshKey` changes (the agent made a file). */
export function useChatFiles(cwd: string | null, refreshKey: string, machine?: Pick<RemoteMachine, "host" | "user" | "port"> | null): ChatFolderFiles {
  const host = machine?.host ?? null;
  const user = machine?.user ?? null;
  const port = machine?.port ?? null;
  // Tagged with its folder, so a switch never shows the previous folder's tree.
  const [result, setResult] = useState<{ cwd: string; files: ChatFolderFiles } | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let live = true;
    (host ? indexRemoteFolder({ host, user, port }, cwd) : indexChatFolder(cwd)).then(
      (index) => live && setResult({ cwd, files: { files: index.files, set: new Set(index.files), truncated: index.truncated, error: null } }),
      (reason: unknown) => live && setResult({ cwd, files: { ...EMPTY, error: reason instanceof Error ? reason.message : String(reason) } }),
    );
    return () => {
      live = false;
    };
  }, [cwd, refreshKey, host, user, port]);

  return cwd && result?.cwd === cwd ? result.files : EMPTY;
}
