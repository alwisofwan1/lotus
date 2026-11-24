import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentRunHistory } from "../AgentRunHistory";
import { createInMemoryAgentRunStore } from "../../../services/agent-run-store";
import { buildRunRecord } from "../../../services/agent-run-record";

async function seeded() {
  const store = createInMemoryAgentRunStore();
  await store.append(buildRunRecord({
    agentId: "n1", kind: "run", outcome: "completed", startedAt: 0, endedAt: 3000, sessionId: "s1",
    actions: ["Reading a.ts", "Running: npm test"],
  }));
  return store;
}

describe("AgentRunHistory", () => {
  it("shows an empty state when the node has no runs", async () => {
    render(<AgentRunHistory agentId="n1" store={createInMemoryAgentRunStore()} onClose={() => {}} />);
    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
  });

  it("lists past runs and reveals their actions on click", async () => {
    render(<AgentRunHistory agentId="n1" store={await seeded()} onClose={() => {}} />);
    const row = await screen.findByRole("button", { name: /completed/i });
    fireEvent.click(row);
    expect(await screen.findByText(/Reading a.ts/)).toBeInTheDocument();
  });

  it("closes via the close button", async () => {
    const onClose = vi.fn();
    render(<AgentRunHistory agentId="n1" store={await seeded()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close run history" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
