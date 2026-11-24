import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TicketSaveQueue, type TicketEditorState } from "@/modules/tasks/editor/ticket-save-queue";
import type { TicketEditOutcome, TicketEdits, VaultTicketDetail } from "@/modules/tasks/services/vault-api";

const detail = (revision: string, overrides: Partial<VaultTicketDetail> = {}): VaultTicketDetail => ({
  ticket: { file: "TKT-1.md", ticket: "TKT-1", title: "Title", status: "todo", tags: [], modifiedAt: 0 },
  sections: [
    { heading: "Summary", body: "Old summary" },
    { heading: "Plan", body: "Old plan" },
  ],
  revision,
  ...overrides,
});

function setup(send: (base: string, edits: TicketEdits) => Promise<TicketEditOutcome>) {
  const states: TicketEditorState[] = [];
  const queue = new TicketSaveQueue(detail("r1"), send, (state) => states.push(state), 800, () => 42);
  return { queue, last: () => states[states.length - 1] ?? queue.snapshot };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("autosaving a vault ticket", () => {
  it("waits for a pause in typing, then sends ONE save with the latest text", async () => {
    const send = vi.fn(async (): Promise<TicketEditOutcome> => ({ kind: "saved", detail: detail("r2") }));
    const { queue } = setup(send);

    queue.queueSection(0, "Summary", "N");
    queue.queueSection(0, "Summary", "New");
    await vi.advanceTimersByTimeAsync(799);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("r1", { sections: [{ index: 0, heading: "Summary", body: "New" }] });
  });

  it("saves status at once, not after the typing delay", async () => {
    const send = vi.fn(async (): Promise<TicketEditOutcome> => ({ kind: "saved", detail: detail("r2") }));
    const { queue } = setup(send);
    queue.setStatus("in-progress");
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledWith("r1", { status: "in-progress", sections: [] });
  });

  it("sends the next save against the revision the last one returned — never racing itself", async () => {
    let release!: () => void;
    const send = vi
      .fn<(base: string, edits: TicketEdits) => Promise<TicketEditOutcome>>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ kind: "saved", detail: detail("r2") }); }))
      .mockResolvedValueOnce({ kind: "saved", detail: detail("r3") });
    const { queue, last } = setup(send);

    queue.setStatus("in-progress");
    queue.setTitle("New title"); // typed while the first save is out
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenNthCalledWith(2, "r2", { title: "New title", sections: [] });
    expect(last().detail.revision).toBe("r3");
    expect(last().dirty).toBe(false);
  });

  it("on a conflict keeps the unsaved text and offers to lay it on top when they changed something else", async () => {
    const theirs = detail("r9", { sections: [{ heading: "Summary", body: "Old summary" }, { heading: "Plan", body: "Obsidian edited the plan" }] });
    const send = vi
      .fn<(base: string, edits: TicketEdits) => Promise<TicketEditOutcome>>()
      .mockResolvedValueOnce({ kind: "conflict", detail: theirs })
      .mockResolvedValueOnce({ kind: "saved", detail: detail("r10") });
    const { queue, last } = setup(send);

    queue.queueSection(0, "Summary", "My summary");
    await vi.advanceTimersByTimeAsync(800);
    expect(last().conflict?.revision).toBe("r9");
    expect(last().canApplyOnTop).toBe(true);
    expect(last().dirty).toBe(true);

    await queue.applyOnTop();
    expect(send).toHaveBeenLastCalledWith("r9", { sections: [{ index: 0, heading: "Summary", body: "My summary" }] });
    expect(last().conflict).toBeNull();
  });

  it("refuses to lay edits on top when they changed the SAME section", async () => {
    const theirs = detail("r9", { sections: [{ heading: "Summary", body: "Obsidian rewrote the summary" }, { heading: "Plan", body: "Old plan" }] });
    const send = vi.fn(async (): Promise<TicketEditOutcome> => ({ kind: "conflict", detail: theirs }));
    const { queue, last } = setup(send);

    queue.queueSection(0, "Summary", "My summary");
    await vi.advanceTimersByTimeAsync(800);
    expect(last().canApplyOnTop).toBe(false);
    await queue.applyOnTop();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reload drops the held edits and takes the file as it is", async () => {
    const send = vi.fn(async (): Promise<TicketEditOutcome> => ({ kind: "conflict", detail: detail("r9") }));
    const { queue, last } = setup(send);
    queue.queueSection(0, "Summary", "mine");
    await vi.advanceTimersByTimeAsync(800);
    queue.reload(detail("r9"));
    expect(last()).toMatchObject({ conflict: null, dirty: false });
    expect(last().detail.revision).toBe("r9");
  });

  it("takes an outside change silently when nothing is being edited", () => {
    const { queue, last } = setup(vi.fn());
    queue.externalChange(detail("r5", { sections: [{ heading: "Summary", body: "From Obsidian" }] }));
    expect(last().detail.sections[0].body).toBe("From Obsidian");
    expect(last().conflict).toBeNull();
  });

  it("but flags one at once while edits are held", () => {
    const { queue, last } = setup(vi.fn());
    queue.queueSection(1, "Plan", "typing…");
    queue.externalChange(detail("r5"));
    expect(last().conflict?.revision).toBe("r5");
  });

  it("keeps the edit and says why when the save fails outright", async () => {
    const send = vi.fn(async () => { throw new Error("disk full"); });
    const { queue, last } = setup(send);
    queue.setStatus("released");
    await vi.advanceTimersByTimeAsync(0);
    expect(last().error).toContain("disk full");
    expect(last().dirty).toBe(true);
  });
});

describe("typing back to the original", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops the pending edit, so nothing is written", async () => {
    const send = vi.fn();
    const states: TicketEditorState[] = [];
    const queue = new TicketSaveQueue(detail("r1"), send, (s) => states.push(s));
    queue.queueSection(0, "Summary", "Changed");
    queue.queueSection(0, "Summary", "Old summary");
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).not.toHaveBeenCalled();
    expect(states[states.length - 1].dirty).toBe(false);
  });
});
