import { formatTaskKey, parseTaskKey } from "@/modules/tasks/services/task-key";
import type { ProjectCapabilities, TrackerTask } from "@/modules/tasks/types";
import type { VaultTicket } from "@/modules/tasks/services/vault-api";
import { OBSIDIAN_SOURCE_ID } from "@/modules/tasks/services/ticket-source-settings";

/**
 * The one project id every vault ticket belongs to. A vault is one project in the tracker, and it
 * is the Obsidian ticket source's id — the same value, named for what each side uses it for.
 */
export const VAULT_PROJECT_ID = OBSIDIAN_SOURCE_ID;

/**
 * What a vault allows from Lotus.
 *
 * It never holds a Lotus task: a ticket is born in Notion and copied over by hand, so a task made
 * "in" the vault would be a ticket nobody filed. Its rows' status and title can be changed from
 * the list — through the same surgical edit as its own page — and it has no priority to change.
 * Its manual order is Lotus's own, kept in the layout rather than in the files.
 */
export const VAULT_CAPABILITIES: ProjectCapabilities = {
  holdsTasks: false,
  editRows: true,
  reorder: true,
  hasPriority: false,
};

export function toTrackerTaskFromTicket(ticket: VaultTicket): TrackerTask {
  const parsed = parseTaskKey(ticket.ticket);
  const created = Date.parse(ticket.created ?? "");

  return {
    // The FILE, not `ticket:` — two files in the real vault both say `ticket: DRAFT`, and keying
    // on that would collapse them into one row.
    id: ticket.file,
    projectId: VAULT_PROJECT_ID,
    ...(parsed ? { number: parsed.number } : {}),
    ...(parsed ? { key: formatTaskKey(parsed.prefix, parsed.number) ?? undefined } : {}),
    title: ticket.title,
    // Raw. The vault's seven words are its own; translating them is what `issues/02` exists to
    // stop.
    status: ticket.status as TrackerTask["status"],
    // A vault ticket has no priority at all. `none` is the absence of a claim, which is exactly
    // true here — not a guess dressed as one.
    priority: "none",
    createdAt: Number.isNaN(created) ? ticket.modifiedAt : created,
    // mtime, never `updated:` — that field is a date without a clock, is optional, and lags.
    updatedAt: ticket.modifiedAt,
    labels: ticket.tags ?? [],
  };
}
