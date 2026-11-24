import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, sep } from "node:path";

/** The folder under the state dir; the server and the mobile adapter both name it. */
export const CHAT_ATTACHMENTS_DIR = "chat-attachments";
/** What Claude and Codex take as pictures; anything else goes by its path. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** The API's limit for one image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const UNSENT_TTL_MS = 24 * 3600_000;
const SENT_MARK = ".sent";
const THREAD_ID = /^[A-Za-z0-9_-]{1,80}$/;
const EXT = /^\.[A-Za-z0-9]{1,10}$/;

import type { PromptAttachment } from "../types/provider-bridge.js";

export type { PromptAttachment };

/** A refusal the route answers with `status`, worded for the person who attached the file. */
export class AttachmentRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AttachmentRefused";
  }
}

export interface SaveInput {
  thread: string;
  name: string;
  mimeType?: string;
  sha256: string;
  body: AsyncIterable<Buffer | string> | Iterable<Buffer | string>;
}

const isImage = (mime: string | undefined) => IMAGE_MIME_TYPES.some((m) => m === mime);

/** Copies of files sent from another machine (ADR-0069): `<root>/<thread>/<sha256><ext>`. */
export class ChatAttachmentStore {
  constructor(readonly root: string, private readonly now: () => number = Date.now) {}

  /** Streams the body to disk; keeps it only when it fits and hashes to what the sender named. */
  async save({ thread, name, mimeType, sha256, body }: SaveInput): Promise<{ path: string; sha256: string; sizeBytes: number }> {
    if (!THREAD_ID.test(thread)) throw new AttachmentRefused(400, "thread must be a chat id");
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new AttachmentRefused(400, "sha256 must be 64 hex characters");
    const limit = isImage(mimeType) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    const dir = join(this.root, thread);
    mkdirSync(dir, { recursive: true });
    const ext = extname(name);
    const path = join(dir, `${sha256}${EXT.test(ext) ? ext.toLowerCase() : ""}`);
    const temp = join(dir, `.${randomUUID()}.part`);
    const hash = createHash("sha256");
    const out = createWriteStream(temp);
    let size = 0;
    try {
      for await (const chunk of body) {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        size += buf.length;
        if (size > limit) throw new AttachmentRefused(413, `${name} is too large; ${isImage(mimeType) ? "images go up to 5 MB" : "files go up to 10 MB"}`);
        hash.update(buf);
        if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      if (hash.digest("hex") !== sha256) throw new AttachmentRefused(422, `${name} arrived damaged; send it again`);
      if (existsSync(path)) {
        rmSync(temp, { force: true });
        const now = new Date(this.now());
        utimesSync(path, now, now);
      } else renameSync(temp, path);
      return { path, sha256, sizeBytes: size };
    } catch (err) {
      out.destroy();
      rmSync(temp, { force: true });
      throw err;
    }
  }

  /** A sent file stays until its chat goes; only unsent ones are swept. */
  markSent(paths: readonly string[]): void {
    for (const path of paths) if (this.owns(path) && existsSync(path)) writeFileSync(`${path}${SENT_MARK}`, "");
  }

  /** Takes the path as given or as `checkAttachments` resolved it (macOS `/var` is `/private/var`). */
  owns(path: string): boolean {
    return path.startsWith(`${this.root}${sep}`) || inside(path, [this.root]);
  }

  dropThread(thread: string): void {
    if (THREAD_ID.test(thread)) rmSync(join(this.root, thread), { recursive: true, force: true });
  }

  /** Deletes files uploaded but never sent, older than a day. Returns how many went. */
  sweep(maxAgeMs = UNSENT_TTL_MS): number {
    if (!existsSync(this.root)) return 0;
    let removed = 0;
    for (const thread of readdirSync(this.root)) {
      const dir = join(this.root, thread);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (file.endsWith(SENT_MARK)) continue;
        const path = join(dir, file);
        if (existsSync(`${path}${SENT_MARK}`)) continue;
        if (this.now() - statSync(path).mtimeMs > maxAgeMs) {
          rmSync(path, { force: true });
          removed++;
        }
      }
    }
    return removed;
  }
}

function inside(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    let real: string;
    try {
      real = realpathSync(root);
    } catch {
      return false;
    }
    return path.startsWith(`${real}${sep}`);
  });
}

/** Checks what a `send` names: real files under `roots` (the upload store, the cell's folder). */
export function checkAttachments(raw: unknown, roots: readonly string[]): PromptAttachment[] {
  if (!Array.isArray(raw)) throw new AttachmentRefused(400, "attachments must be a list");
  return raw.map((item: unknown) => {
    const a = (item ?? {}) as Record<string, unknown>;
    const kind = a["kind"] === "image" ? "image" : "file";
    const name = typeof a["name"] === "string" && a["name"].trim() ? a["name"] : "file";
    const mimeType = typeof a["mimeType"] === "string" ? a["mimeType"] : undefined;
    const path = typeof a["path"] === "string" ? a["path"] : "";
    if (!isAbsolute(path)) throw new AttachmentRefused(400, `${name} is not a full path`);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new AttachmentRefused(409, `${name} is no longer there; attach it again`);
    }
    if (!inside(real, roots)) throw new AttachmentRefused(403, `${name} is outside this chat's folder`);
    const meta = statSync(real);
    if (!meta.isFile()) throw new AttachmentRefused(400, `${name} is a folder; attach files`);
    if (kind === "image") {
      if (!isImage(mimeType)) throw new AttachmentRefused(400, `${name}: PNG, JPEG, GIF or WebP images only`);
      if (meta.size > MAX_IMAGE_BYTES) throw new AttachmentRefused(413, `${name} is too large; images go up to 5 MB`);
    }
    return { kind, path: real, name, ...(mimeType === undefined ? {} : { mimeType }), sizeBytes: meta.size };
  });
}
