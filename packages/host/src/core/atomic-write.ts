import {
  promises as fs,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Use a sibling temporary file so the atomic rename cannot cross filesystems. */
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
