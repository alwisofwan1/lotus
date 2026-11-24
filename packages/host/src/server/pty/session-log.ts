import { appendFileSync, closeSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/// 8 MB live plus one older generation: hours of a chatty agent, still a file a phone can page.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/// A session's output as the host received it, at the daemon's absolute byte offsets, so history
/// outlives both the host process and the daemon's 256 KB ring. `<name>.base` holds the offset of
/// the oldest byte kept — it only moves on rotation, so it is rewritten rarely.
export class SessionLog {
  private readonly cur: string;
  private readonly prev: string;
  private readonly basePath: string;
  private base: number;

  constructor(dir: string, name: string, private readonly maxBytes = DEFAULT_MAX_BYTES) {
    this.cur = join(dir, `${name}.log`);
    this.prev = `${this.cur}.1`;
    this.basePath = join(dir, `${name}.base`);
    let base = 0;
    try {
      base = Number.parseInt(readFileSync(this.basePath, "utf8"), 10) || 0;
    } catch {
      // no rotation yet: history starts at byte 0
    }
    this.base = base;
  }

  total(): number {
    return this.base + sizeOf(this.prev) + sizeOf(this.cur);
  }

  /// Stores output that starts at `offset` and returns the part that was new.
  append(offset: number, bytes: Buffer): Buffer {
    const total = this.total();
    if (offset > total) {
      // shortcut: a gap (host down while the agent wrote more than the daemon's ring) drops the
      // older history, because the files must stay contiguous; keep a gap index if it matters.
      rmSync(this.prev, { force: true });
      rmSync(this.cur, { force: true });
      this.setBase(offset);
    }
    const fresh = bytes.subarray(Math.max(this.total() - offset, 0));
    if (fresh.length === 0) return fresh;
    appendFileSync(this.cur, fresh, { mode: 0o600 });
    if (sizeOf(this.cur) > this.maxBytes) {
      this.setBase(this.base + sizeOf(this.prev));
      rmSync(this.prev, { force: true });
      renameSync(this.cur, this.prev);
    }
    return fresh;
  }

  /// From an absolute offset; a returned `offset` past the request means those bytes are gone.
  read(fromByte: number, maxBytes: number): { text: string; offset: number } {
    const prevSize = sizeOf(this.prev);
    const total = this.base + prevSize + sizeOf(this.cur);
    const start = Math.min(Math.max(fromByte, this.base), total);
    const local = start - this.base;
    if (local < prevSize) {
      return { text: readRange(this.prev, local, Math.min(maxBytes, prevSize - local)), offset: start };
    }
    return { text: readRange(this.cur, local - prevSize, Math.min(maxBytes, total - start)), offset: start };
  }

  remove(): void {
    for (const path of [this.cur, this.prev, this.basePath]) rmSync(path, { force: true });
  }

  private setBase(base: number): void {
    this.base = base;
    writeFileSync(this.basePath, String(base), { mode: 0o600 });
  }
}

function readRange(path: string, from: number, length: number): string {
  if (length <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
