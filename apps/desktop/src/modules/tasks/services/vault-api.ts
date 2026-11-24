import { tauriInvoke } from "@/lib/tauri/runtime";

/**
 * The vault commands, as the frontend calls them: two reads and the one surgical edit.
 *
 * Same shape as `task-api.ts`, and injectable for the same reason: outside Tauri there is no
 * reader at all, and a surface that cannot be rendered in a test is a surface nobody checks.
 */

export type VaultTicket = {
  file: string;
  ticket: string;
  title: string;
  /** Raw — the vault's own word, never translated into Lotus's vocabulary. */
  status: string;
  tags: string[];
  parent?: string;
  notion?: string;
  /** The Notion `last_edited_time` of the page last pulled into `## From Notion`. Absent until a pull. */
  notionPulled?: string | null;
  created?: string;
  updated?: string;
  modifiedAt: number;
};

export type TicketSection = {
  /** Absent for the preamble: the Notion paste that sits above the first `##`. */
  heading?: string;
  body: string;
};

export type VaultTicketDetail = {
  ticket: VaultTicket;
  sections: TicketSection[];
  /** A fingerprint of the file as read. An edit must hand it back, or it is refused as stale. */
  revision: string;
};

/** What an edit may change — see `vault_ticket_edit.rs`. Nothing else in the file is touched. */
export type TicketEdits = {
  status?: string;
  title?: string;
  sections?: Array<{ index: number; heading: string | null; body: string }>;
  /**
   * A section Lotus writes whole — `From Notion` on a pull. Replaced when the ticket has it,
   * inserted before the first `##` otherwise. Never sent together with `sections`.
   */
  ownedSection?: { heading: string; body: string };
  /** Sets `notion_pulled:` (an ISO timestamp). */
  notionPulled?: string;
};

export type TicketEditOutcome =
  | { kind: "saved"; detail: VaultTicketDetail }
  /** The file changed since the edit's base revision. Nothing was written; this is it now. */
  | { kind: "conflict"; detail: VaultTicketDetail };

export type VaultClient = {
  list: (vaultPath: string) => Promise<VaultTicket[]>;
  get: (vaultPath: string, file: string) => Promise<VaultTicketDetail | null>;
  edit: (
    vaultPath: string,
    file: string,
    baseRevision: string,
    edits: TicketEdits,
    today?: string,
  ) => Promise<TicketEditOutcome>;
};

/** The person's LOCAL date, as the vault writes dates. UTC would be yesterday for half the evening in GMT+7. */
export function localDate(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function createTauriVaultClient(invokeFn: InvokeFn = tauriInvoke as InvokeFn): VaultClient {
  return {
    async list(vaultPath) {
      return await invokeFn<VaultTicket[]>("vault_list_tickets", { vaultPath });
    },
    async get(vaultPath, file) {
      return (await invokeFn<VaultTicketDetail | null>("vault_get_ticket", { vaultPath, file })) ?? null;
    },
    async edit(vaultPath, file, baseRevision, edits, today = localDate()) {
      return await invokeFn<TicketEditOutcome>("vault_edit_ticket", {
        vaultPath,
        file,
        baseRevision,
        today,
        edits: { sections: [], ...edits },
      });
    },
  };
}
