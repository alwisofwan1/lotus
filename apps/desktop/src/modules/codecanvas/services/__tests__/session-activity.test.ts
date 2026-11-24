import { describe, expect, it } from "vitest";
import { applyAskToSession, recordSessionAsk, refineSessionTitle, titleFromAsk } from "../session-activity";
import { createInMemoryCanvasSessionStore } from "../session-store";
import type { CanvasSessionRecord } from "../session-record";

function session(overrides: Partial<CanvasSessionRecord> = {}): CanvasSessionRecord {
  return {
    id: "s1",
    projectId: "cp_1",
    nodeId: "n1",
    runner: "claude",
    cwd: "/tmp/demo",
    title: "Bima · sesi baru",
    titleSource: "auto",
    status: "live",
    origin: "manual",
    turnCount: 0,
    lastActivityAt: 1_000,
    createdAt: 1_000,
    ...overrides,
  };
}

describe("applyAskToSession", () => {
  it("names an untitled conversation after the first thing asked of it", () => {
    const next = applyAskToSession(session(), "perbaiki resume yang putus di tengah", 5_000);
    expect(next.title).toBe("perbaiki resume yang putus di tengah");
    expect(next.titleSource).toBe("prompt");
  });

  it("keeps the first ask as the title while the preview follows the latest one", () => {
    const first = applyAskToSession(session(), "perbaiki resume", 5_000);
    const second = applyAskToSession(first, "sekarang tambahkan tesnya", 6_000);
    expect(second.title).toBe("perbaiki resume");
    expect(second.lastPrompt).toBe("sekarang tambahkan tesnya");
  });

  it("never overwrites a title a human chose", () => {
    const renamed = session({ title: "Refactor sesi", titleSource: "manual" });
    const next = applyAskToSession(renamed, "apa kabar", 5_000);
    expect(next.title).toBe("Refactor sesi");
    expect(next.titleSource).toBe("manual");
  });

  it("counts the turn and moves the activity clock", () => {
    const next = applyAskToSession(session({ turnCount: 2 }), "lanjut", 9_000);
    expect(next.turnCount).toBe(3);
    expect(next.lastActivityAt).toBe(9_000);
  });

  it("ignores an empty ask rather than blanking a good title", () => {
    const row = session({ title: "perbaiki resume", lastPrompt: "perbaiki resume" });
    expect(applyAskToSession(row, "   \n ", 9_000)).toBe(row);
  });

  it("flattens a pasted block into one line", () => {
    const next = applyAskToSession(session(), "baris satu\n\n  baris dua", 5_000);
    expect(next.title).toBe("baris satu baris dua");
  });
});

describe("titleFromAsk", () => {
  it("truncates at a word boundary", () => {
    const title = titleFromAsk(
      "tolong periksa kenapa panel sesi tidak pernah memperbarui judulnya setelah percakapan berjalan",
    );
    expect(title.length).toBeLessThanOrEqual(65);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it("keeps a slash command exactly as typed", () => {
    expect(titleFromAsk("/review --fix")).toBe("/review --fix");
  });
});

describe("recordSessionAsk", () => {
  it("persists the updated row", async () => {
    const store = createInMemoryCanvasSessionStore();
    const row = session();
    await store.upsert(row);

    await recordSessionAsk(store, row, "perbaiki resume", 5_000);

    const [saved] = await store.list("cp_1");
    expect(saved.title).toBe("perbaiki resume");
    expect(saved.lastPrompt).toBe("perbaiki resume");
    expect(saved.turnCount).toBe(1);
  });

  it("does not write at all for an empty ask", async () => {
    const store = createInMemoryCanvasSessionStore();
    const row = session();
    await store.upsert(row);
    let writes = 0;
    const counting = { ...store, upsert: async (s: CanvasSessionRecord) => { writes += 1; await store.upsert(s); } };

    await recordSessionAsk(counting, row, "", 5_000);

    expect(writes).toBe(0);
  });
});

describe("escape residue never becomes a title", () => {
  it("ignores a mouse report that reached the ask buffer", () => {
    const row = session();
    expect(applyAskToSession(row, "<0;50;20M<0;50;20m<0;41;21M", 5_000)).toBe(row);
  });

  it("heals a row already titled with residue, on the next real ask", () => {
    const stuck = session({ title: "<0;50;20M<0;50;20m<0;41;21M", titleSource: "auto" });
    expect(applyAskToSession(stuck, "perbaiki resume", 5_000).title).toBe("perbaiki resume");
  });

  it("still accepts a short numeric answer", () => {
    expect(applyAskToSession(session(), "2", 5_000).lastPrompt).toBe("2");
  });
});

describe("a title stuck on residue heals even after truncation", () => {
  it("recognises the truncated form the row actually stores", () => {
    const stuck = session({ title: "<0;50;20M<0;50;20m<0;41;21M<0;4…", titleSource: "auto" });
    expect(applyAskToSession(stuck, "buatkan pantun", 5_000).title).toBe("buatkan pantun");
  });
});

describe("refineSessionTitle", () => {
  it("replaces the first ask with the model's title", async () => {
    const store = createInMemoryCanvasSessionStore();
    const row = session({ title: "buat pantun", titleSource: "prompt" });
    await store.upsert(row);
    const next = await refineSessionTitle(store, row, async () => "  Pantun tentang ngoding ");
    expect(next).toMatchObject({ title: "Pantun tentang ngoding", titleSource: "auto" });
    expect((await store.list("cp_1"))[0].title).toBe("Pantun tentang ngoding");
  });

  it("keeps a rename made while the model was answering", async () => {
    const store = createInMemoryCanvasSessionStore();
    const row = session({ title: "buat pantun", titleSource: "prompt" });
    await store.upsert(row);
    const next = await refineSessionTitle(store, row, async () => {
      await store.upsert({ ...row, title: "Mine", titleSource: "manual" });
      return "Pantun tentang ngoding";
    });
    expect(next).toBeNull();
    expect((await store.list("cp_1"))[0]).toMatchObject({ title: "Mine", titleSource: "manual" });
  });

  it("writes nothing for an empty answer", async () => {
    const store = createInMemoryCanvasSessionStore();
    const row = session({ title: "buat pantun", titleSource: "prompt" });
    await store.upsert(row);
    expect(await refineSessionTitle(store, row, async () => "  ")).toBeNull();
    expect((await store.list("cp_1"))[0].titleSource).toBe("prompt");
  });
});
