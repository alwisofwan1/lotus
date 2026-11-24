import {
  promises as fs,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes `data` as pretty-printed JSON to `target` atomically.
 *
 * Strategy: serialize to a sibling tmp file in the same directory, then
 * `rename()` over the target. Same-directory rename is atomic on POSIX
 * filesystems and on Windows NTFS, avoiding the cross-volume EXDEV failure
 * that `os.tmpdir()` would risk.
 *
 * The tmp filename embeds the PID so concurrent writers in different
 * processes never collide.
 */
export async function atomicWriteJSON(target: string, data: unknown): Promise<void> {
  const tmp = tmpPath(target);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/** Synchronous variant of {@link atomicWriteJSON} for callers in non-async paths. */
export function atomicWriteSync(target: string, data: unknown): void {
  const tmp = tmpPath(target);
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, target);
}

function tmpPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
}
