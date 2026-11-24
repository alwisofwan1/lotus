import { describe, expect, it } from "vitest";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { statusIsOpen, statusLabel } from "@/modules/tasks/services/task-vocabulary";

describe("the vault's vocabulary", () => {
  it("puts work in flight first and shipped work last", () => {
    expect(VAULT_VOCABULARY.order).toEqual([
      "in-progress",
      "in-review",
      "qa-revision",
      "ready-to-prod",
      "todo",
      "backlog",
      "released",
    ]);
  });

  it("speaks the vault's own words, not Lotus's", () => {
    // `qa-revision` and `ready-to-prod` are the two that have no Lotus equivalent at all, and the
    // two the human's Dataview board gives a column each.
    expect([
      statusLabel(VAULT_VOCABULARY, "qa-revision"),
      statusLabel(VAULT_VOCABULARY, "ready-to-prod"),
      statusLabel(VAULT_VOCABULARY, "released"),
    ]).toEqual(["QA Revision", "Ready to Prod", "Released"]);
  });

  it("counts everything but released as still somebody's problem", () => {
    const open = VAULT_VOCABULARY.order.filter((status) => statusIsOpen(VAULT_VOCABULARY, status));

    expect(open).toEqual([
      "in-progress",
      "in-review",
      "qa-revision",
      "ready-to-prod",
      "todo",
      "backlog",
    ]);
  });
});
