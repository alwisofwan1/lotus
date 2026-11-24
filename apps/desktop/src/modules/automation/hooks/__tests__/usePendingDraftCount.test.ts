import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AutomationClient, AutomationDraft } from "../../services/automation-api";
import { usePendingDraftCount } from "../usePendingDraftCount";

const pending = (id: string, kind: string): AutomationDraft => ({
  id,
  runId: `r-${id}`,
  automationId: "a1",
  kind,
  subject: id,
  status: "pending",
  content: null,
  slack: null,
  result: null,
  sentUrl: null,
  createdAtMs: 1,
});

describe("usePendingDraftCount", () => {
  it("counts an Automation Ask with the drafts that wait, for the sidebar badge", async () => {
    const client = { drafts: vi.fn(async () => [pending("d1", "pr_review"), { ...pending("q1", "ask"), ask: { question: "?", choices: [], actionKind: "agent_prompt" } } as AutomationDraft]) } as unknown as AutomationClient;
    const { result } = renderHook(() => usePendingDraftCount(client, () => () => undefined));
    await waitFor(() => expect(result.current).toBe(2));
  });

  it("counts one row per PR and a waiting result once, as the Inbox does", async () => {
    const review = (id: string, at: number): AutomationDraft => ({
      ...pending(id, "pr_review"),
      createdAtMs: at,
      content: { repo: "acme/api", number: 7, url: "u", headSha: "h", summary: "", comments: [], droppedComments: 0, reply: null },
    } as unknown as AutomationDraft);
    const result = { ...pending("res1", "agent_prompt"), result: { text: "hi", dm: "off", channel: "C1" } } as unknown as AutomationDraft;
    const client = {
      drafts: vi.fn(async () => [review("d1", 1), review("d2", 2), result]),
      results: vi.fn(async () => [result]),
    } as unknown as AutomationClient;
    const { result: count } = renderHook(() => usePendingDraftCount(client, () => () => undefined));
    await waitFor(() => expect(count.current).toBe(2));
  });

  it("reads zero when drafts fail", async () => {
    const client = { drafts: vi.fn(async () => Promise.reject(new Error("no"))), results: vi.fn(async () => []) } as unknown as AutomationClient;
    const { result } = renderHook(() => usePendingDraftCount(client, () => () => undefined));
    await waitFor(() => expect(client.drafts).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });
});
