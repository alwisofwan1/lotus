// What the composer holds before a message goes (#279). Pure: which files are images, and why a
// file cannot go. The Rust runtime checks again on send; this is what the chip says beforehand.

import type { Attachment } from "./thread-event";

/** The API's limit for one image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** What Claude takes as a picture. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** The most one file copied to another machine may be (ADR-0069). */
export const MAX_REMOTE_FILE_BYTES = 10 * 1024 * 1024;

/** A paste crosses IPC as one base64 string; a bigger file is attached by its path instead. */
export const MAX_PASTE_BYTES = 50 * 1024 * 1024;

const IMAGE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

export interface DraftAttachment {
  id: string;
  attachment: Attachment;
  /** Why it cannot go, as the chip says it; null when it can. */
  problem: string | null;
  /** Still on its way to the chat's machine, as the chip says it. */
  pending?: string | null;
  /** How much of it is there, 0–100; null while the copy cannot report it (waiting for the machine). */
  progress?: number | null;
}

/** How far the copies still on their way are, 0–100 weighted by size; null when none can say. */
export function copyProgress(drafts: readonly DraftAttachment[]): number | null {
  const going = drafts.filter((d) => d.pending && typeof d.progress === "number");
  if (going.length === 0) return null;
  const weight = (d: DraftAttachment) => d.attachment.sizeBytes || 1;
  const total = going.reduce((sum, d) => sum + weight(d), 0);
  return Math.round(going.reduce((sum, d) => sum + weight(d) * (d.progress as number), 0) / total);
}

export function attachmentProblem(attachment: Attachment): string | null {
  if (attachment.kind !== "image") return null;
  if (!IMAGE_MIME_TYPES.some((type) => type === attachment.mimeType)) return "Not supported · PNG, JPEG, GIF or WebP";
  if ((attachment.sizeBytes ?? 0) > MAX_IMAGE_BYTES) return "Too large · max 5 MB";
  return null;
}

/** Why it cannot be copied to another machine; images keep their own 5 MB rule. */
export function remoteProblem(attachment: Attachment): string | null {
  if (attachment.remote !== undefined) return null;
  return (attachment.sizeBytes ?? 0) > MAX_REMOTE_FILE_BYTES ? "Too large · max 10 MB on another machine" : null;
}

/** Sent as a copy, not the user's own file on that machine. */
export const isCopy = (attachment: Attachment) => attachment.remote !== undefined && attachment.remote !== attachment.path;

/** The runtime's words for "the machine cannot be reached; it will be tried again". */
export const linkIsDown = (reason: string) => reason.startsWith("waiting for ");

/** A file from disk (dropped or picked), as the runtime's path inspection describes it. */
export function draftFromPath(file: { path: string; name: string; size: number; isDirectory: boolean }): DraftAttachment {
  const extension = file.name.includes(".") ? file.name.split(".").at(-1)!.toLowerCase() : "";
  const mimeType = IMAGE_BY_EXTENSION[extension] ?? null;
  const attachment: Attachment = {
    kind: mimeType ? "image" : "file",
    path: file.path,
    name: file.name,
    mimeType,
    sizeBytes: file.size,
  };
  return { id: file.path, attachment, problem: file.isDirectory ? "A folder · attach files" : attachmentProblem(attachment) };
}

export function draftFromAttachment(attachment: Attachment): DraftAttachment {
  return { id: attachment.path, attachment, problem: attachmentProblem(attachment) };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}
