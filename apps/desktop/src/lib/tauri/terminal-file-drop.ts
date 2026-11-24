import { tauriInvoke } from "@/lib/tauri/runtime";
import type { CodeSpaceStoredWorkspaceLocation } from "./codespace";

export type TerminalFileDropUploadFile = { path: string; name: string; size: number };
export type TerminalFileDropInspectedPath = TerminalFileDropUploadFile & { isFile: boolean; isDirectory: boolean };
export type TerminalFileDropUploadResult = {
  uploaded: Array<{ sourcePath: string; remotePath: string }>;
  failed: Array<{ sourcePath: string; reason: string }>;
  cancelled: boolean;
};

export function inspectTerminalFileDropPaths(paths: string[]): Promise<TerminalFileDropInspectedPath[]> {
  return tauriInvoke("terminal_file_drop_inspect_paths", { paths });
}

export function uploadTerminalFileDropSshBatch(args: {
  jobId: string;
  target: Extract<CodeSpaceStoredWorkspaceLocation, { kind: "ssh" }>;
  remoteCwd: string;
  files: TerminalFileDropUploadFile[];
}): Promise<TerminalFileDropUploadResult> {
  return tauriInvoke("terminal_file_drop_upload_ssh_batch", args);
}

export function cancelTerminalFileDropUpload(jobId: string): Promise<void> {
  return tauriInvoke("terminal_file_drop_cancel_upload", { jobId });
}
