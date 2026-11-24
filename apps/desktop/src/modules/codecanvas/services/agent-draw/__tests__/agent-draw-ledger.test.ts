import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDraftLedgerForTests,
  latestDraftBatch,
  pendingDraftBatches,
  recordDraftBatch,
  resolveDraftBatch,
  subscribeDraftLedger,
} from "../agent-draw-ledger";

function batch(id: string, extra: Partial<Parameters<typeof recordDraftBatch>[0]> = {}) {
  return recordDraftBatch({ batchId: id, nodeIds: [`${id}-n`], edgeIds: [`${id}-e`], summary: "1 shape", ...extra });
}

describe("agent-draw-ledger", () => {
  beforeEach(() => clearDraftLedgerForTests());

  it("starts empty", () => {
    expect(pendingDraftBatches()).toEqual([]);
    expect(latestDraftBatch()).toBeNull();
  });

  it("records a draft batch and exposes it as pending", () => {
    batch("b1", { summary: "5 shapes · 5 connectors", agentName: "Nova" });
    const pending = pendingDraftBatches();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ batchId: "b1", summary: "5 shapes · 5 connectors", agentName: "Nova" });
    expect(pending[0].nodeIds).toEqual(["b1-n"]);
  });

  it("returns the most recently recorded batch as latest", () => {
    batch("b1");
    batch("b2");
    expect(latestDraftBatch()?.batchId).toBe("b2");
  });

  it("resolving a batch removes it from pending", () => {
    batch("b1");
    batch("b2");
    resolveDraftBatch("b1");
    expect(pendingDraftBatches().map((b) => b.batchId)).toEqual(["b2"]);
    expect(latestDraftBatch()?.batchId).toBe("b2");
  });

  it("resolving an unknown batch id is a no-op", () => {
    batch("b1");
    resolveDraftBatch("ghost");
    expect(pendingDraftBatches()).toHaveLength(1);
  });

  it("notifies subscribers on record and resolve", () => {
    let ticks = 0;
    const unsub = subscribeDraftLedger(() => { ticks += 1; });
    batch("b1");
    resolveDraftBatch("b1");
    unsub();
    expect(ticks).toBe(2);
  });
});
