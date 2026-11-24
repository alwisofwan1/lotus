import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotionFactoryRun, type NotionTicketFactory } from "@/modules/tasks/components/NotionFactoryRun";
import type { FactoryRunClient } from "@/modules/factory";

const claude = { id: "p1", name: "Claude", agent: "claude", args: "", instructions: "" };
const ticket = { key: "TKT-5", title: "Export the report", pageId: "page-5", url: "https://www.notion.so/page-5" };

function client(): FactoryRunClient {
  return {
    findCheckout: vi.fn(async () => ({ workspaceId: "ws-1", cwd: "/code/app" })),
    listRuns: vi.fn(async () => []),
    start: vi.fn(async () => "r1"),
    raiseCap: vi.fn(async () => 1),
    abort: vi.fn(async () => {}),
    onChanged: vi.fn(async () => () => {}),
  };
}

function factory(over: Partial<NotionTicketFactory> = {}): NotionTicketFactory {
  return {
    client: client(),
    sourceId: "n1",
    repos: [
      { id: "s1", repo: "o/web", account: "me" },
      { id: "s2", repo: "o/api", account: "work" },
    ],
    workspaces: () => [{ id: "ws-1", cwd: "/code/app", remote: false }],
    readBody: vi.fn(async () => "Properties:\n- Priority: High\n\nThe page"),
    ...over,
  };
}

describe("NotionFactoryRun", () => {
  beforeEach(() => window.localStorage.removeItem("factory-notion-repo:n1"));

  it("starts the run in the repo picked, reading the page only when it starts", async () => {
    const f = factory();
    render(<NotionFactoryRun factory={f} ticket={ticket} presets={[claude]} />);
    fireEvent.change(screen.getByLabelText("Repo for this ticket's code"), { target: { value: "s2" } });
    expect(window.localStorage.getItem("factory-notion-repo:n1")).toBe("s2");
    expect(f.readBody).not.toHaveBeenCalled();
    const run = await screen.findByRole("button", { name: "Run in Factory" });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    await waitFor(() => expect(f.client.start).toHaveBeenCalled());
    expect(f.client.findCheckout).toHaveBeenLastCalledWith("o/api", expect.anything(), null);
    const input = JSON.stringify(vi.mocked(f.client.start).mock.calls[0][0]);
    expect(input).toContain("TKT-5");
    expect(input).toContain("Priority: High");
    expect(input).toContain("page-5");
  });

  it("opens on the repo remembered for the database; with no GitHub source it says what to add", () => {
    window.localStorage.setItem("factory-notion-repo:n1", "s2");
    const { unmount } = render(<NotionFactoryRun factory={factory()} ticket={ticket} presets={[claude]} />);
    expect(screen.getByLabelText("Repo for this ticket's code")).toHaveValue("s2");
    unmount();
    render(<NotionFactoryRun factory={factory({ repos: [] })} ticket={ticket} presets={[claude]} />);
    expect(screen.getByText(/Add a GitHub ticket source/)).toBeInTheDocument();
  });
});
