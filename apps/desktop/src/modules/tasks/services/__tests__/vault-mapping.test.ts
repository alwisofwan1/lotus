import { describe, expect, it } from "vitest";
import {
  toTrackerTaskFromTicket,
  VAULT_PROJECT_ID,
} from "@/modules/tasks/services/vault-mapping";
import type { VaultTicket } from "@/modules/tasks/services/vault-api";

function ticket(overrides: Partial<VaultTicket> = {}): VaultTicket {
  return {
    file: "TKT-987.md",
    ticket: "TKT-987",
    title: "Regional Pricing",
    status: "in-review",
    tags: [],
    modifiedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("a vault ticket as a tracker row", () => {
  it("keeps the key the ticket already has", () => {
    /*
      The key cannot come from the project the way a Lotus task's does. A vault holds tickets with
      DIFFERENT prefixes — 76 `TKT-*` and 2 `DRAFT` in the real one — so one prefix on the project
      would print `TKT-?` over a ticket that is not an TKT at all.
    */
    expect(toTrackerTaskFromTicket(ticket()).key).toBe("TKT-987");
  });

  it("carries no key when the ticket's own is not one", () => {
    // `DRAFT` and `TKT-XXX` are truthy `ticket:` values and appear on the human's board, but
    // neither is a key anybody can type back.
    expect(toTrackerTaskFromTicket(ticket({ ticket: "DRAFT" })).key).toBeUndefined();
    expect(toTrackerTaskFromTicket(ticket({ ticket: "TKT-XXX" })).key).toBeUndefined();
  });

  it("is identified by its file, because `ticket:` is not unique", () => {
    // Two files in the real vault both say `ticket: DRAFT`.
    const [a, b] = [
      toTrackerTaskFromTicket(ticket({ file: "DRAFT-a.md", ticket: "DRAFT" })),
      toTrackerTaskFromTicket(ticket({ file: "DRAFT-b.md", ticket: "DRAFT" })),
    ];

    expect([a.id, b.id]).toEqual(["DRAFT-a.md", "DRAFT-b.md"]);
  });

  it("keeps the vault's own status word and claims no priority", () => {
    const row = toTrackerTaskFromTicket(ticket({ status: "qa-revision" }));

    expect([row.status, row.priority]).toEqual(["qa-revision", "none"]);
  });

  it("sorts by the file's modification time, not by the `updated:` somebody typed", () => {
    // `updated:` is a date with no clock, is not required, and lags reality.
    const row = toTrackerTaskFromTicket(ticket({ updated: "2026-01-01", modifiedAt: 1_800_000_000_000 }));

    expect(row.updatedAt).toBe(1_800_000_000_000);
  });

  it("belongs to the one vault project", () => {
    expect(toTrackerTaskFromTicket(ticket()).projectId).toBe(VAULT_PROJECT_ID);
  });
});
