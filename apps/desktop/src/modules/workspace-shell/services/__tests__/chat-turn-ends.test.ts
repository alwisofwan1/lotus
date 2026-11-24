import { describe, expect, it } from "vitest";
import { chatTurnEnds } from "@/modules/workspace-shell/services/chat-turn-ends";

type T = { id: string; status: "working" | "waiting" | null; lastTurnEndedAt: number | null; parentId: string | null };
const t = (id: string, status: T["status"], lastTurnEndedAt: number | null = null, parentId: string | null = null): T => ({
  id,
  status,
  lastTurnEndedAt,
  parentId,
});
const map = (...threads: T[]) => new Map(threads.map((x) => [x.id, x]));

describe("chatTurnEnds", () => {
  it("reports a turn that ended", () => {
    expect(chatTurnEnds(map(t("a", "working", 1)), [t("a", null, 2)])).toEqual([{ threadId: "a", waiting: false }]);
  });

  it("reports a turn that started and ended between two listings", () => {
    expect(chatTurnEnds(map(t("a", null, 1)), [t("a", null, 5)])).toEqual([{ threadId: "a", waiting: false }]);
  });

  it("reports a chat that starts waiting, once", () => {
    expect(chatTurnEnds(map(t("a", "working")), [t("a", "waiting")])).toEqual([{ threadId: "a", waiting: true }]);
    expect(chatTurnEnds(map(t("a", "waiting")), [t("a", "waiting")])).toEqual([]);
  });

  it("stays quiet for a first listing, a running turn, an unchanged thread and a delegated chat", () => {
    expect(chatTurnEnds(new Map(), [t("a", null, 9)])).toEqual([]);
    expect(chatTurnEnds(map(t("a", null, 1)), [t("a", "working", 1)])).toEqual([]);
    expect(chatTurnEnds(map(t("a", null, 1)), [t("a", null, 1)])).toEqual([]);
    expect(chatTurnEnds(map(t("c", "working", 1, "lead")), [t("c", null, 2, "lead")])).toEqual([]);
  });
});
