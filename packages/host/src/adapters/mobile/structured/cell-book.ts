import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Turn } from "../../../types/conversation.js";
import type { FleetMember } from "../../../types/fleet.js";

/** What a cell was started with — enough to start its runner again. */
export interface SavedSpawn {
  cwd: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  profileId?: string;
}

export interface SavedCell {
  member: FleetMember;
  spawn: SavedSpawn;
  /** The runner's own conversation id: what a restarted host resumes. */
  thread?: string;
  turns: Turn[];
}

/** The Chat cells this host holds, on disk, so a host restart can bring them back (`plans/chat-survives-host-restart`). */
export class CellBook {
  private readonly cells: Map<string, SavedCell>;

  constructor(private readonly path: string) {
    this.cells = new Map(read(path).map((c) => [c.member.paneId, c]));
  }

  all(): SavedCell[] {
    return [...this.cells.values()];
  }

  put(cell: SavedCell): void {
    this.cells.set(cell.member.paneId, cell);
    this.flush();
  }

  remove(paneId: string): void {
    if (this.cells.delete(paneId)) this.flush();
  }

  private flush(): void {
    // Owner-only from the first byte: the file holds the operator's prompts.
    const tmp = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.all()), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

function read(path: string): SavedCell[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed)) return parsed.filter(isSavedCell);
  } catch {
    // fall through: kept aside below, so a bad write never costs the cells it held
  }
  renameSync(path, `${path}.corrupt`);
  return [];
}

function isSavedCell(v: unknown): v is SavedCell {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Partial<SavedCell>;
  return typeof c.member?.paneId === "string" && typeof c.spawn?.cwd === "string" && Array.isArray(c.turns);
}
