import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AddTicketSourceModal } from "@/modules/tasks/components/AddTicketSourceModal";

function kind(name: RegExp) {
  return screen.getByRole("button", { name });
}

describe("Add a ticket source", () => {
  it("lists every kind; without a Notion account only Obsidian can be picked", () => {
    const onPickObsidian = vi.fn();
    render(<AddTicketSourceModal hasObsidian={false} onPickObsidian={onPickObsidian} notionConnected={false} onPickNotion={vi.fn()} githubAccounts={0} onPickGitHub={vi.fn()} onClose={vi.fn()} />);

    expect((kind(/Notion database/) as HTMLButtonElement).disabled).toBe(true);
    expect(kind(/Notion database/).textContent).toContain("Connect in Connectors first");
    // No gh login and no way to Connectors: nothing to pick.
    expect((kind(/GitHub Issues/) as HTMLButtonElement).disabled).toBe(true);
    expect(kind(/GitHub Issues/).textContent).toContain("Log in with gh");
    expect((kind(/Linear/) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Sources are independent. Lotus tasks work with none connected.")).toBeTruthy();

    fireEvent.click(kind(/Obsidian vault/));
    expect(onPickObsidian).toHaveBeenCalledTimes(1);
  });

  it("does not offer a second vault", () => {
    const onPickObsidian = vi.fn();
    render(<AddTicketSourceModal hasObsidian onPickObsidian={onPickObsidian} notionConnected={false} onPickNotion={vi.fn()} githubAccounts={0} onPickGitHub={vi.fn()} onClose={vi.fn()} />);

    const obsidian = kind(/Obsidian vault/) as HTMLButtonElement;
    expect(obsidian.disabled).toBe(true);
    expect(obsidian.textContent).toContain("Added");
    fireEvent.click(obsidian);
    expect(onPickObsidian).not.toHaveBeenCalled();
  });

  it("offers Notion once its account is connected", () => {
    const onPickNotion = vi.fn();
    render(<AddTicketSourceModal hasObsidian onPickObsidian={vi.fn()} notionConnected onPickNotion={onPickNotion} githubAccounts={0} onPickGitHub={vi.fn()} onClose={vi.fn()} />);
    const notion = kind(/Notion database/) as HTMLButtonElement;
    expect(notion.disabled).toBe(false);
    fireEvent.click(notion);
    expect(onPickNotion).toHaveBeenCalledTimes(1);
  });

  it("offers GitHub once gh has a login; without one its row opens Connectors", () => {
    const onPickGitHub = vi.fn();
    const onOpenConnectors = vi.fn();
    const { rerender } = render(
      <AddTicketSourceModal hasObsidian onPickObsidian={vi.fn()} notionConnected onPickNotion={vi.fn()} githubAccounts={0} onPickGitHub={onPickGitHub} onOpenConnectors={onOpenConnectors} onClose={vi.fn()} />,
    );
    fireEvent.click(kind(/GitHub Issues/));
    expect(onOpenConnectors).toHaveBeenCalledTimes(1);
    expect(onPickGitHub).not.toHaveBeenCalled();

    rerender(
      <AddTicketSourceModal hasObsidian onPickObsidian={vi.fn()} notionConnected onPickNotion={vi.fn()} githubAccounts={2} onPickGitHub={onPickGitHub} onOpenConnectors={onOpenConnectors} onClose={vi.fn()} />,
    );
    expect(kind(/GitHub Issues/).textContent).not.toContain("Connectors");
    fireEvent.click(kind(/GitHub Issues/));
    expect(onPickGitHub).toHaveBeenCalledTimes(1);
  });
});
