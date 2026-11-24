import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddNotionDatabaseSheet } from "@/modules/tasks/components/AddNotionDatabaseSheet";
import { notionSourceId, type DataSourceSchema, type NotionSourceClient } from "@/modules/tasks/services/notion-source";
import type { NotionStatus } from "@/modules/connectors/services/connectors-api";

const account: NotionStatus = { state: "connected", kind: "personal", name: "Alwi", email: "alwi@company.com", workspace: null, connectedAtMs: 1 };
const DS = "248104cd-477e-80af-bc30-000bea2dd2a5";

const schema: DataSourceSchema = {
  id: DS,
  title: "Orbit board",
  url: "https://www.notion.so/board",
  properties: [
    { id: "title", name: "Name", kind: "title", status: null, uniquePrefix: null, relationTarget: null },
    { id: "id", name: "ID", kind: "unique_id", status: null, uniquePrefix: "TKT", relationTarget: null },
    {
      id: "st",
      name: "Status",
      kind: "status",
      status: {
        options: [{ id: "todo", name: "Todo", color: null }, { id: "rel", name: "Released", color: null }],
        groups: [
          { id: "g1", name: "To-do", optionIds: ["todo"] },
          { id: "g2", name: "In progress", optionIds: [] },
          { id: "g3", name: "Complete", optionIds: ["rel"] },
        ],
      },
      uniquePrefix: null,
      relationTarget: null,
    },
    { id: "cust", name: "Customer", kind: "relation", status: null, uniquePrefix: null, relationTarget: "other" },
    { id: "par", name: "Parent item", kind: "relation", status: null, uniquePrefix: null, relationTarget: DS },
  ],
};

function client(): NotionSourceClient {
  return {
    search: vi.fn(async () => [{ id: DS, title: "Orbit board", url: "https://www.notion.so/board" }]),
    describe: vi.fn(async () => ({
      schema,
      mapping: { title: "title", key: "id", status: "st", assignee: null, labels: null, parent: "par" },
    })),
    read: vi.fn(),
    forget: vi.fn(),
    write: vi.fn(),
    trash: vi.fn(),
    create: vi.fn(),
    writeBody: vi.fn(),
    pageMarkdown: vi.fn(),
  };
}

describe("Add a Notion database", () => {
  it("picks a database, shows the fields and the board's words, and adds it read only", async () => {
    const onAdd = vi.fn();
    const notion = client();
    render(<AddNotionDatabaseSheet account={account} client={notion} existingIds={new Set()} onAdd={onAdd} onClose={vi.fn()} />);

    expect(screen.getByText("Signed in as Alwi · alwi@company.com")).toBeTruthy();
    fireEvent.click(await screen.findByRole("option", { name: /Orbit board/ }));

    expect(await screen.findByLabelText("Status")).toHaveValue("st");
    // Parent offers only the relation into this same database.
    const parent = screen.getByLabelText("Parent") as HTMLSelectElement;
    expect([...parent.options].map((o) => o.textContent)).toEqual(["— not used", "Parent item"]);
    expect(screen.getByText(/To-do · open/)).toBeTruthy();
    expect(screen.getByText(/Complete · closed/)).toBeTruthy();
    // Read only unless the person chooses Manage (task "Ticket Sources 09").
    expect(screen.getByRole("radio", { name: /Read only/ })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Add Orbit board" }));

    expect(onAdd).toHaveBeenCalledWith({
      id: notionSourceId(DS),
      kind: "notion",
      name: "Orbit board",
      dataSourceId: DS,
      url: "https://www.notion.so/board",
      mapping: { title: "title", key: "id", status: "st", assignee: null, labels: null, parent: "par" },
      statuses: schema.properties[2].status,
      permission: "read_only",
    });
  });

  it("lets a field be changed, and not used", async () => {
    const onAdd = vi.fn();
    render(<AddNotionDatabaseSheet account={account} client={client()} existingIds={new Set()} onAdd={onAdd} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("option", { name: /Orbit board/ }));
    fireEvent.change(await screen.findByLabelText("Key"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Orbit board" }));
    expect(onAdd.mock.calls[0][0].mapping.key).toBeNull();
  });

  it("can be added as Manage, and says what that lets Lotus do", async () => {
    const onAdd = vi.fn();
    render(<AddNotionDatabaseSheet account={account} client={client()} existingIds={new Set()} onAdd={onAdd} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("option", { name: /Orbit board/ }));
    const manage = await screen.findByRole("radio", { name: /Manage/ });
    expect(screen.getByRole("radio", { name: /Read only/ })).toBeChecked();

    fireEvent.click(manage);
    fireEvent.click(screen.getByRole("button", { name: "Add Orbit board" }));

    expect(onAdd.mock.calls[0][0].permission).toBe("manage");
  });

  it("does not add a database twice", async () => {
    render(
      <AddNotionDatabaseSheet account={account} client={client()} existingIds={new Set([notionSourceId(DS)])} onAdd={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("option", { name: /Orbit board/ }));
    await waitFor(() => expect(screen.getByText("This database is already a ticket source.")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Add Orbit board" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers \"Match notes by key\" when there is a vault, and adds the board with it on", async () => {
    const onAdd = vi.fn();
    render(
      <AddNotionDatabaseSheet account={account} client={client()} existingIds={new Set()} notesName="orbit-vault" onAdd={onAdd} onClose={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("option", { name: /Orbit board/ }));
    const match = await screen.findByRole("checkbox", { name: /Match notes by key in orbit-vault/ });
    expect(match).not.toBeChecked();
    fireEvent.click(match);
    fireEvent.click(screen.getByRole("button", { name: "Add Orbit board" }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ matchNotes: true }));
  });

  it("does not mention notes at all without a vault", async () => {
    render(<AddNotionDatabaseSheet account={account} client={client()} existingIds={new Set()} onAdd={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("option", { name: /Orbit board/ }));
    await screen.findByRole("button", { name: "Add Orbit board" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.body.textContent).not.toMatch(/notes/i);
  });
});
