import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewRoom } from "../ReviewRoom";
import type { AutomationClient, AutomationDraft } from "../../services/automation-api";

const draft: AutomationDraft = { id: "d1", automationId: "a1", runId: "r1", kind: "pr_review", subject: "org/repo#42", status: "sent", createdAtMs: 10,
  slack: null, result: null, sentUrl: "https://github.com/org/repo/pull/42#pullrequestreview-1",
  content: { repo: "org/repo", number: 42, url: "https://github.com/org/repo/pull/42", headSha: "sha1", summary: "One blocker", comments: [], droppedComments: 0,
    reply: { verdict: "changes-needed", points: [] },
    previous: [{ path: "a.ts", line: 1, body: "Tenant leak", status: "not-fixed", note: null, hasThread: true, replies: [{ author: "engineerGH", body: "The guard now uses organization_id" }] }] } };
const room = { history: [draft], feedback: [{ id: "C1:2", author: "engineer", text: "Fixed the tenant check", atMs: 20 }] };

describe("review room", () => {
  it("allows another attempt after the started agent run fails", async () => {
    const reviewAgain = vi.fn(async () => ({ status: "started", runId: "r2" }));
    const runs = vi.fn(async () => [{ id: "r2", status: "failed", detail: "Agent timeout" }]);
    render(<ReviewRoom draft={draft} client={{ reviewRoom: async () => room, reviewAgain, runs } as unknown as AutomationClient} />);
    fireEvent.click(screen.getByText("Review history and feedback"));
    await screen.findByText("Fixed the tenant check");
    fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Agent timeout");
    expect(screen.getByRole("button", { name: "Review again" })).toBeEnabled();
  });
  it("places engineer feedback between the rounds it connects", async () => {
    const next = { ...draft, id: "d2", createdAtMs: 30 };
    render(<ReviewRoom draft={next} client={{ reviewRoom: async () => ({ ...room, history: [draft, next] }) } as unknown as AutomationClient} />);
    fireEvent.click(screen.getByText("Review history and feedback"));
    await screen.findByText("Review 2");
    const items = screen.getByRole("list", { name: "Review timeline" }).children;
    expect(items[0]).toHaveTextContent("Review 1");
    expect(items[1]).toHaveTextContent("Fixed the tenant check");
    expect(items[2]).toHaveTextContent("Review 2");
  });
  it("keeps history and new feedback together and starts a draft-only round with the user's focus", async () => {
    const reviewAgain = vi.fn(async () => ({ status: "started", runId: "r2" }));
    const client = { reviewRoom: vi.fn(async () => room), reviewAgain, sendDraft: vi.fn(), approveDraft: vi.fn() } as unknown as AutomationClient;
    render(<ReviewRoom draft={draft} client={client} />);
    fireEvent.click(screen.getByText("Review history and feedback"));
    expect(await screen.findByText("Fixed the tenant check")).toBeInTheDocument();
    expect(screen.getByText("New feedback")).toBeInTheDocument();
    expect(screen.getByText(/Tenant leak/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("GitHub replies"));
    expect(screen.getByText("The guard now uses organization_id")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Focus for the next review"), { target: { value: "Verify tenant isolation" } });
    fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    await waitFor(() => expect(reviewAgain).toHaveBeenCalledWith("a1", draft.content!.url, "Verify tenant isolation"));
    expect(await screen.findByText(/Re-review started/)).toBeInTheDocument();
    expect(client.sendDraft).not.toHaveBeenCalled();
    expect(client.approveDraft).not.toHaveBeenCalled();
  });

  it("retains the focus and allows retry after a failed re-review request", async () => {
    const reviewAgain = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "started", runId: "r2" });
    render(<ReviewRoom draft={draft} client={{ reviewRoom: async () => room, reviewAgain } as unknown as AutomationClient} />);
    fireEvent.click(screen.getByText("Review history and feedback"));
    await screen.findByText("Fixed the tenant check");
    fireEvent.change(screen.getByLabelText("Focus for the next review"), { target: { value: "Check again" } });
    fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByLabelText("Focus for the next review")).toHaveValue("Check again");
    fireEvent.click(screen.getByRole("button", { name: "Review again" }));
    expect(await screen.findByText(/Re-review started/)).toBeInTheDocument();
  });
});

describe("whereItGoes — the sentence beside Send (16b v2)", () => {
  it("names each destination, and says so when there is none", async () => {
    const { whereItGoes } = await import("../DraftCard");
    expect(whereItGoes({ github: true, approve: false, slack: true, account: "alwi", channel: "#eng" })).toBe("GitHub comment as alwi · #eng thread");
    expect(whereItGoes({ github: true, approve: true, slack: false, account: "alwi" })).toBe("GitHub approval as alwi");
    expect(whereItGoes({ github: false, approve: false, slack: true, channel: "#eng" })).toBe("#eng thread");
    expect(whereItGoes({ github: false, approve: false, slack: false })).toMatch(/^Nowhere yet/);
  });
});
