import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GitHubConnector } from "@/modules/connectors/components/GitHubConnector";
import { describeHealth } from "@/modules/tasks/services/source-health";

describe("GitHub connector page", () => {
  it("lists each GitHub ticket source with its health and the account it reads as", () => {
    const health = describeHealth({
      label: "GitHub",
      name: "cli/cli",
      health: { state: "lost_access", why: "login" },
      syncing: false,
      syncedAtMs: null,
      nowMs: 0,
    });
    render(
      <GitHubConnector
        accounts={[{ login: "alwisofwan1", active: true }]}
        usedBy={[]}
        sources={[{ id: "github-cli-cli", name: "cli/cli", account: "alwisofwan1", health }]}
      />,
    );
    const row = within(screen.getByRole("listitem", { name: "cli/cli" }));
    expect(row.getByText(/GitHub · no access · as alwisofwan1/)).toBeTruthy();
    expect(row.getByText(/gh auth login/)).toBeTruthy();
  });

  it("shows no ticket-source section when no repo is a source", () => {
    render(<GitHubConnector accounts={[]} usedBy={[]} />);
    expect(screen.queryByText("Ticket sources")).toBeNull();
  });
});
