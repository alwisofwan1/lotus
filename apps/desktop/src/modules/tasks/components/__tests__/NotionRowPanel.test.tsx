import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotionRowPanel } from "@/modules/tasks/components/NotionRowPanel";
import { notionVocabulary, type BodyOutcome, type NotionRow, type WriteOutcome } from "@/modules/tasks/services/notion-source";

const row: NotionRow = {
  pageId: "p1", url: "https://www.notion.so/p1", key: "TKT-996", title: "Interview HSS QA checklist",
  status: null, assignees: [], assigneeIds: [], labels: [], parents: [],
  createdTime: "2026-09-01T10:00:00.000Z", lastEditedTime: "2026-09-02T10:00:00.000Z",
};
const RAW = "<details>\n<summary>**Defect Report — 1  ****`TO DO`**</summary>\n    - [ ] ..<br>**Note:**<br>- email: \n</details>";

describe("a Notion ticket, delegated from its page", () => {
  it("hands the agent the page exactly as Notion sent it, not the version drawn for reading", async () => {
    const onDelegate = vi.fn();
    render(
      <NotionRowPanel
        row={row}
        client={{ pageMarkdown: vi.fn(async () => ({ markdown: RAW, truncated: false, unknownBlockIds: [] })) }}
        projectName="Orbit Meeting Tasks"
        vocabulary={notionVocabulary(null)}
        position={null}
        onBack={vi.fn()}
        delegation={{
          presets: [{ id: "a", name: "Alwi", agent: "ccs acme", args: "--dangerously-skip-permissions", instructions: "" }],
          ready: true,
          busy: false,
          targets: [{ id: "w1", name: "Orbit" }],
          targetId: "w1",
          onTargetChange: vi.fn(),
          onDelegate,
          onNewPreset: vi.fn(),
          onEditPreset: vi.fn(),
        }}
      />,
    );
    await screen.findByText("Note:");

    // The menu is a <details>; its preset rows are named by preset and command.
    fireEvent.click(screen.getByRole("button", { name: /^Alwi/, hidden: true }));

    await waitFor(() => expect(onDelegate).toHaveBeenCalled());
    expect(onDelegate.mock.calls[0][1]).toBe(RAW);
  });
});

describe("a Notion ticket in a Manage database (task \"Ticket Sources 09\")", () => {
  const statuses = {
    options: [{ id: "todo", name: "Todo", color: null }, { id: "done", name: "Released", color: null }],
    groups: [
      { id: "g1", name: "To-do", optionIds: ["todo"] },
      { id: "g2", name: "In progress", optionIds: [] },
      { id: "g3", name: "Complete", optionIds: ["done"] },
    ],
  };
  const ticket: NotionRow = { ...row, status: "todo", assignees: ["Alwi"], assigneeIds: ["u1"], labels: ["billing"] };
  const people = [{ id: "u1", name: "Alwi" }, { id: "u2", name: "Doni" }];

  function menuOf(name: string): HTMLElement {
    const details = screen.getByRole("group", { name }).querySelector("details")!;
    return details as HTMLElement;
  }
  function openMenu(name: string): HTMLElement {
    const details = menuOf(name) as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    return details;
  }
  function closeMenu(details: HTMLElement) {
    (details as HTMLDetailsElement).open = false;
    fireEvent(details, new Event("toggle"));
  }
  function pickStatus(name: string) {
    fireEvent.click(screen.getByRole("menuitemradio", { name, hidden: true }));
  }
  function pickPerson(name: string): HTMLElement {
    const menu = openMenu("Assignee");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name }));
    return menu;
  }
  function statusShown(): string {
    return screen.getByRole("group", { name: "Status" }).querySelector(".tk-prop-label")?.textContent ?? "";
  }

  function renderManaged(write: (change: unknown, seen: NotionRow) => Promise<WriteOutcome>, editing = true, shown = ticket) {
    return render(
      <NotionRowPanel
        row={shown}
        client={{ pageMarkdown: vi.fn(async () => ({ markdown: "", truncated: false, unknownBlockIds: [] })) }}
        projectName="Orbit board"
        vocabulary={notionVocabulary(statuses)}
        position={null}
        onBack={vi.fn()}
        editing={editing ? { people, labels: ["billing", "backend"], write } : undefined}
      />,
    );
  }

  it("a Read only database shows its fields, and nothing to change them with", () => {
    renderManaged(vi.fn(), false);
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add assignee|Assignee:/ })).toBeNull();
    expect(screen.getAllByText(/read only here/).length).toBeGreaterThan(0);
  });

  it("changing the status writes it, as the person saw the ticket, and shows what Notion saved", async () => {
    const write = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "saved", row: { ...ticket, status: "done" } }));
    renderManaged(write);

    pickStatus("Released");

    await waitFor(() => expect(write).toHaveBeenCalledWith({ field: "status", value: "done" }, ticket));
    await waitFor(() => expect(statusShown()).toBe("Released"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a status changed in Notion since it was opened is refused, and Notion's version is shown", async () => {
    const write = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "conflict", fresh: { ...ticket, status: "done" } }));
    renderManaged(write);

    pickStatus("Released");

    expect((await screen.findByRole("alert")).textContent).toMatch(/changed in Notion since you opened it/);
    expect(statusShown()).toBe("Released");
  });

  it("a refused write says why and changes nothing", async () => {
    const write = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "refused", message: "Notion refused the change: restricted_resource: no access" }));
    renderManaged(write);

    pickStatus("Released");

    expect((await screen.findByRole("alert")).textContent).toMatch(/Write refused.*restricted_resource/);
    expect(statusShown()).toBe("Todo");
  });

  it("shows only who is assigned; the rest are one search away, and the choice is written once", async () => {
    const write = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "saved", row: { ...ticket, assignees: ["Alwi", "Doni"], assigneeIds: ["u1", "u2"] } }));
    renderManaged(write);

    // Not a wall of everyone on the board: the assigned person, and the way to change it.
    const summary = () => screen.getByRole("group", { name: "Assignee" }).querySelector("summary")!;
    expect(summary().getAttribute("aria-label")).toBe("Assignee: Alwi");
    expect(summary().textContent).not.toContain("Doni");

    const menu = openMenu("Assignee");
    fireEvent.change(within(menu).getByRole("searchbox", { name: "Find a person" }), { target: { value: "do" } });
    expect(within(menu).queryByRole("menuitemcheckbox", { name: "Alwi" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Doni" }));
    expect(write).not.toHaveBeenCalled();

    closeMenu(menu);

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledWith({ field: "assignees", value: ["u1", "u2"] }, ticket);
    await waitFor(() => expect(summary().getAttribute("aria-label")).toBe("Assignee: Alwi, Doni"));
  });

  it("a click anywhere outside closes the menu, and that is when the choice is written", async () => {
    const write = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "saved", row: { ...ticket, assignees: ["Alwi", "Doni"], assigneeIds: ["u1", "u2"] } }));
    renderManaged(write);
    const menu = openMenu("Assignee") as HTMLDetailsElement;
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Doni" }));

    // A click inside the menu keeps it open.
    fireEvent.pointerDown(within(menu).getByRole("searchbox", { name: "Find a person" }));
    expect(menu.open).toBe(true);

    fireEvent.pointerDown(document.body);
    fireEvent(menu, new Event("toggle"));

    expect(menu.open).toBe(false);
    await waitFor(() => expect(write).toHaveBeenCalledWith({ field: "assignees", value: ["u1", "u2"] }, ticket));
  });

  it("only one menu is open at a time: opening another closes the first", () => {
    renderManaged(vi.fn());
    const status = screen.getByRole("group", { name: "Status" }).querySelector("details") as HTMLDetailsElement;
    status.open = true;

    const assignee = menuOf("Assignee");
    fireEvent.pointerDown(assignee.querySelector("summary")!);

    expect(status.open).toBe(false);
  });

  it("closing the menu without a change writes nothing", async () => {
    const write = vi.fn();
    renderManaged(write);
    const menu = openMenu("Assignee");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Doni" }));
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Doni" }));
    closeMenu(menu);
    await new Promise((r) => setTimeout(r, 0));
    expect(write).not.toHaveBeenCalled();
  });

  it("a person Notion sent without a name is not shown as an id", () => {
    render(
      <NotionRowPanel
        row={{ ...ticket, assignees: [""], assigneeIds: ["aef84e40-20b9-4acc-848e-de3391df0608"] }}
        client={{ pageMarkdown: vi.fn(async () => ({ markdown: "", truncated: false, unknownBlockIds: [] })) }}
        projectName="Orbit board" vocabulary={notionVocabulary(statuses)} position={null} onBack={vi.fn()}
        editing={{ people: [{ id: "aef84e40-20b9-4acc-848e-de3391df0608", name: "aef84e40-20b9-4acc-848e-de3391df0608" }], labels: [], write: vi.fn() }}
      />,
    );
    expect(screen.getAllByText("Unnamed user").length).toBeGreaterThan(0);
    expect(screen.queryByText(/aef84e40/)).toBeNull();
  });

  it("labels work the same way, by name", async () => {
    const write = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "saved", row: { ...ticket, labels: ["billing", "backend"] } }));
    renderManaged(write);

    const menu = openMenu("Labels");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "backend" }));
    closeMenu(menu);

    await waitFor(() => expect(write).toHaveBeenCalledWith({ field: "labels", value: ["billing", "backend"] }, ticket));
  });

  it("the notice stays when the list hands down a newer copy of the same ticket", async () => {
    const write = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "conflict", fresh: { ...ticket, status: "done" } }));
    const { rerender } = renderManaged(write);
    pickStatus("Released");
    await screen.findByRole("alert");

    // What a sync, or the write's own answer landing in the list, does: the same page, a new object.
    const synced = { ...ticket, status: "done" };
    rerender(
      <NotionRowPanel row={synced} client={{ pageMarkdown: vi.fn(async () => ({ markdown: "", truncated: false, unknownBlockIds: [] })) }}
        projectName="Orbit board" vocabulary={notionVocabulary(statuses)} position={null} onBack={vi.fn()}
        editing={{ people, labels: ["billing", "backend"], write }} />,
    );

    expect(screen.getByRole("alert").textContent).toMatch(/changed in Notion since you opened it/);
  });

  it("a second change waits for the first write, even when the list updates meanwhile", async () => {
    let answer: (o: WriteOutcome) => void = () => undefined;
    const write = vi.fn(() => new Promise<WriteOutcome>((resolve) => (answer = resolve)));
    const { rerender } = renderManaged(write);
    pickStatus("Released");

    rerender(
      <NotionRowPanel row={{ ...ticket }} client={{ pageMarkdown: vi.fn(async () => ({ markdown: "", truncated: false, unknownBlockIds: [] })) }}
        projectName="Orbit board" vocabulary={notionVocabulary(statuses)} position={null} onBack={vi.fn()}
        editing={{ people, labels: ["billing", "backend"], write }} />,
    );
    closeMenu(pickPerson("Doni"));

    expect(write).toHaveBeenCalledTimes(1);
    answer({ outcome: "saved", row: { ...ticket, status: "done" } });
    await waitFor(() => expect(statusShown()).toBe("Released"));
  });

  it("a change Notion may have saved says so, rather than 'refused'", async () => {
    const write = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "unknown", message: "Notion may have saved the change, but Lotus could not confirm it (timeout). Reopen the ticket to see." }));
    renderManaged(write);
    pickStatus("Released");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/may have saved/);
    expect(alert.textContent).not.toMatch(/refused/i);
  });

  it("the title is edited in place, and the key stays read only", async () => {
    const write = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "saved", row: { ...ticket, title: "Renamed" } }));
    renderManaged(write);

    const title = screen.getByRole("textbox", { name: "Title" });
    title.textContent = "Renamed";
    fireEvent.blur(title);

    await waitFor(() => expect(write).toHaveBeenCalledWith({ field: "title", value: "Renamed" }, ticket));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" }).textContent).toBe("Renamed"));
    expect(screen.queryByRole("textbox", { name: "Key" })).toBeNull();
  });
});

describe("sub-tickets on a Notion ticket (task \"Ticket Sources 15\")", () => {
  const statuses = {
    options: [{ id: "todo", name: "Todo", color: null }, { id: "rev", name: "In review", color: null }],
    groups: [
      { id: "g1", name: "To-do", optionIds: ["todo"] },
      { id: "g2", name: "In progress", optionIds: ["rev"] },
      { id: "g3", name: "Complete", optionIds: [] },
    ],
  };
  const main: NotionRow = { ...row, pageId: "main", key: "TKT-1000", title: "Billing hardening", status: "todo" };
  const child = (n: number, title: string): NotionRow => ({ ...row, pageId: `c${n}`, key: `TKT-${1000 + n}`, title, status: "rev", parents: ["main"] });

  function renderMain(subTickets: Parameters<typeof NotionRowPanel>[0]["subTickets"], shown = main) {
    return render(
      <NotionRowPanel
        row={shown}
        client={{ pageMarkdown: vi.fn(async () => ({ markdown: "", truncated: false, unknownBlockIds: [] })) }}
        projectName="Orbit board"
        vocabulary={notionVocabulary(statuses)}
        position={null}
        onBack={vi.fn()}
        subTickets={subTickets}
      />,
    );
  }

  it("lists the sub-tickets with key, title and status, and opens one", () => {
    const onOpen = vi.fn();
    renderMain({ rows: [child(8, "Stripe webhook"), child(12, "Invoice tab")], add: null, onOpen });

    const section = within(screen.getByRole("region", { name: "Sub-tickets" }));
    expect(section.getByText("2")).toBeTruthy();
    fireEvent.click(section.getByRole("button", { name: /TKT-1008.*Stripe webhook.*In review/ }));
    expect(onOpen).toHaveBeenCalledWith("c8");
  });

  it("adds one from the main ticket; Enter sends the title, and the field clears when Notion saved it", async () => {
    const onAdd = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "saved", row: child(13, "Tag events") }));
    renderMain({ rows: [], add: { onAdd, boardName: "Orbit board", onRefresh: vi.fn() }, onOpen: vi.fn() });
    const section = within(screen.getByRole("region", { name: "Sub-tickets" }));

    const input = section.getByRole("textbox", { name: "New sub-ticket title" });
    fireEvent.change(input, { target: { value: "Tag events" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("Tag events"));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
    expect(section.getByText(/Created in Orbit board with Parent = TKT-1000\. Notion gives the key when it saves\./)).toBeTruthy();
  });

  it("a refused sub-ticket keeps the title typed and says why", async () => {
    const onAdd = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "refused", message: "Notion refused the new ticket: validation_error: x" }));
    renderMain({ rows: [], add: { onAdd, boardName: "Orbit board", onRefresh: vi.fn() }, onOpen: vi.fn() });
    const input = screen.getByRole("textbox", { name: "New sub-ticket title" });
    fireEvent.change(input, { target: { value: "Tag events" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((await screen.findByRole("alert")).textContent).toMatch(/validation_error/);
    expect((input as HTMLInputElement).value).toBe("Tag events");
  });

  it("after an answer that may have created it, the form will not send again until the board is refreshed", async () => {
    const onAdd = vi.fn(async (): Promise<WriteOutcome> => ({ outcome: "unknown", message: "Notion may have created the ticket, but Lotus could not confirm it (timeout). Refresh before adding it again." }));
    const onRefresh = vi.fn();
    renderMain({ rows: [], add: { onAdd, boardName: "Orbit board", onRefresh }, onOpen: vi.fn() });
    const input = screen.getByRole("textbox", { name: "New sub-ticket title" });
    fireEvent.change(input, { target: { value: "Tag events" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toMatch(/may have created/);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Add sub-ticket" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));
    expect(onRefresh).toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("a draft does not follow to another ticket", () => {
    const { rerender } = renderMain({ rows: [], add: { onAdd: vi.fn(), boardName: "Orbit board", onRefresh: vi.fn() }, onOpen: vi.fn() });
    fireEvent.change(screen.getByRole("textbox", { name: "New sub-ticket title" }), { target: { value: "Draft for A" } });

    rerender(
      <NotionRowPanel
        row={child(8, "Stripe webhook")}
        client={{ pageMarkdown: vi.fn(async () => ({ markdown: "", truncated: false, unknownBlockIds: [] })) }}
        projectName="Orbit board" vocabulary={notionVocabulary(statuses)} position={null} onBack={vi.fn()}
        subTickets={{ rows: [], add: { onAdd: vi.fn(), boardName: "Orbit board", onRefresh: vi.fn() }, onOpen: vi.fn() }}
      />,
    );

    expect((screen.getByRole("textbox", { name: "New sub-ticket title" }) as HTMLInputElement).value).toBe("");
  });

  it("without a Parent field mapped, says how to get sub-tickets instead of offering the form", () => {
    renderMain({ rows: [], add: "unmapped", onOpen: vi.fn() });
    expect(screen.getByText("Map a Parent field to add sub-tickets")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "New sub-ticket title" })).toBeNull();
  });

  it("a sub-ticket links back to its main ticket", () => {
    const onOpen = vi.fn();
    renderMain({ rows: [], add: null, onOpen, parent: main }, child(8, "Stripe webhook"));
    fireEvent.click(screen.getByRole("button", { name: /TKT-1000.*Billing hardening/ }));
    expect(onOpen).toHaveBeenCalledWith("main");
  });
});

describe("editing a Notion ticket's body (task \"Ticket Sources 13\")", () => {
  const RAWBODY = "## Description\n\nTag every event.\n";
  const pageClient = (markdown = RAWBODY, unknownBlockIds: string[] = []) => ({
    pageMarkdown: vi.fn(async () => ({ markdown, truncated: false, unknownBlockIds })),
  });
  function renderBody(writeBody: ((seen: string, markdown: string) => Promise<BodyOutcome>) | null, client = pageClient()) {
    return render(
      <NotionRowPanel
        row={{ ...row, status: "todo" }}
        client={client}
        projectName="Orbit board"
        vocabulary={notionVocabulary(null)}
        position={null}
        onBack={vi.fn()}
        editing={writeBody ? { people: [], labels: [], write: vi.fn(), writeBody } : undefined}
      />,
    );
  }

  it("Edit opens Notion's own markdown; Save sends what was opened and what was typed, and shows Notion's answer", async () => {
    const writeBody = vi.fn(async (): Promise<BodyOutcome> => ({ outcome: "saved", markdown: "## Description\n\nTag every event and region.\n" }));
    renderBody(writeBody);
    await screen.findByText("Tag every event.");
    expect(screen.getByText(/editable here/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit body" }));
    const box = screen.getByRole("textbox", { name: "Page body (Notion markdown)" }) as HTMLTextAreaElement;
    expect(box.value).toBe(RAWBODY);
    fireEvent.change(box, { target: { value: "## Description\n\nTag every event and region.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save body" }));

    await waitFor(() => expect(writeBody).toHaveBeenCalledWith(RAWBODY, "## Description\n\nTag every event and region.\n"));
    expect(await screen.findByText("Tag every event and region.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Page body (Notion markdown)" })).toBeNull();
  });

  it("a page changed in Notion since it was opened keeps the edit, and can load Notion's version", async () => {
    const fresh = "## Description\n\nChanged by someone else.\n";
    const writeBody = vi.fn(async (): Promise<BodyOutcome> => ({ outcome: "conflict", fresh }));
    renderBody(writeBody);
    await screen.findByText("Tag every event.");
    fireEvent.click(screen.getByRole("button", { name: "Edit body" }));
    const box = screen.getByRole("textbox", { name: "Page body (Notion markdown)" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "mine\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save body" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/changed in Notion since you opened it/);
    expect(box.value).toBe("mine\n");
    fireEvent.click(screen.getByRole("button", { name: "Load Notion’s version" }));
    expect((screen.getByRole("textbox", { name: "Page body (Notion markdown)" }) as HTMLTextAreaElement).value).toBe(fresh);
  });

  it("what was opened stays what was opened while editing, even when a sync reads a newer page", async () => {
    const V1 = "## Description\n\nSomeone else changed this.\n";
    let version = RAWBODY;
    const client = { pageMarkdown: vi.fn(async () => ({ markdown: version, truncated: false, unknownBlockIds: [] })) };
    const writeBody = vi.fn(async (): Promise<BodyOutcome> => ({ outcome: "conflict", fresh: V1 }));
    const props = (edited: string) => ({
      client, projectName: "Orbit board", vocabulary: notionVocabulary(null), position: null, onBack: vi.fn(),
      editing: { people: [], labels: [], write: vi.fn(), writeBody },
      row: { ...row, status: "todo", lastEditedTime: edited },
    });
    const { rerender } = render(<NotionRowPanel {...props("2026-09-29T10:00:00.000Z")} />);
    await screen.findByText("Tag every event.");
    fireEvent.click(screen.getByRole("button", { name: "Edit body" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Page body (Notion markdown)" }), { target: { value: "mine\n" } });

    // A sync: Notion's page moved on, and the panel reads it again.
    version = V1;
    rerender(<NotionRowPanel {...props("2026-09-29T10:05:00.000Z")} />);
    await waitFor(() => expect(client.pageMarkdown).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Save body" }));
    await waitFor(() => expect(writeBody).toHaveBeenCalledWith(RAWBODY, "mine\n"));
  });

  it("a page with blocks Lotus cannot show is not editable here, and says where to edit it", async () => {
    renderBody(vi.fn(), pageClient(RAWBODY, ["b1"]));
    await screen.findByText("Tag every event.");
    expect(screen.queryByRole("button", { name: "Edit body" })).toBeNull();
    expect(screen.getByText(/blocks Lotus cannot show.*Edit in Notion/i)).toBeTruthy();
  });

  it("Cancel leaves the page as it was, and a Read only board has no Edit", async () => {
    const writeBody = vi.fn();
    renderBody(writeBody);
    await screen.findByText("Tag every event.");
    fireEvent.click(screen.getByRole("button", { name: "Edit body" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Page body (Notion markdown)" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Tag every event.")).toBeTruthy();
    expect(writeBody).not.toHaveBeenCalled();
  });

  it("a Read only board shows the body with nothing to edit it", async () => {
    renderBody(null);
    await screen.findByText("Tag every event.");
    expect(screen.queryByRole("button", { name: "Edit body" })).toBeNull();
  });
});

describe("a Notion page whose body has a block Lotus cannot show (task 'Ticket Sources 16')", () => {
  function renderBody(markdown: string) {
    return render(
      <NotionRowPanel
        row={row}
        client={{ pageMarkdown: vi.fn(async () => ({ markdown, truncated: false, unknownBlockIds: [] })) }}
        projectName="Orbit board"
        vocabulary={notionVocabulary(null)}
        position={null}
        onBack={vi.fn()}
        editing={{
          people: [],
          labels: [],
          write: vi.fn(),
          writeBody: vi.fn(async (): Promise<BodyOutcome> => ({ outcome: "saved", markdown })),
        }}
      />,
    );
  }

  it("does not offer Edit body when a bookmark comes back inline, with no unknown block ids", async () => {
    renderBody('Intro line.\n\n<unknown url="https://www.notion.so/p1#b1" alt="bookmark"/>\n\nMore text.');
    expect(await screen.findByText(/Part of this page cannot be shown here/)).toBeTruthy();
    expect(screen.getByText(/its body is changed in Notion/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit body" })).toBeNull();
  });

  it("still offers Edit body when the tag is only written inside code", async () => {
    renderBody("Write `<unknown/>` for a block Notion cannot show.\n\n```html\n<unknown url=\"u\"/>\n```");
    expect(await screen.findByRole("button", { name: "Edit body" })).toBeTruthy();
  });
});

describe("a Notion ticket whose Delegate failed (LOT2-108)", () => {
  it("says why on the panel, where the person is looking", async () => {
    render(
      <NotionRowPanel
        row={row}
        client={{ pageMarkdown: vi.fn(async () => ({ markdown: "Body", truncated: false, unknownBlockIds: [] })) }}
        projectName="Orbit Meeting Tasks"
        vocabulary={notionVocabulary(null)}
        position={null}
        onBack={vi.fn()}
        delegation={{
          presets: [],
          ready: true,
          busy: false,
          error: "Only a Claude preset can be kept from writing to the ticket's source.",
          targets: [{ id: "w1", name: "Orbit" }],
          targetId: "w1",
          onTargetChange: vi.fn(),
          onDelegate: vi.fn(),
          onNewPreset: vi.fn(),
          onEditPreset: vi.fn(),
        }}
      />,
    );
    await screen.findByText("Body");
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toContain(
      "Only a Claude preset can be kept from writing to the ticket's source.",
    );
  });
});
