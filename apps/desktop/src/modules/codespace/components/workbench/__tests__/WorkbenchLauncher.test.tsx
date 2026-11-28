import { fireEvent, render, screen, within } from "@testing-library/react";
import { FilePlus, GitBranch } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchLauncher, type LauncherAction } from "../WorkbenchLauncher";

const now = new Date("2026-09-29T15:00:00").getTime();
const recent = [
  { path: "/repo/app/Http/UserController.php", at: now - 60_000 * 2 },
  { path: "/repo/routes/web.php", at: now - 60_000 * 14 },
  { path: "/repo/README.md", at: new Date("2026-09-27T10:00:00").getTime() },
];

function setup(props: Partial<Parameters<typeof WorkbenchLauncher>[0]> = {}) {
  const onGoToFile = vi.fn();
  const onOpen = vi.fn();
  const newFile = vi.fn();
  const source = vi.fn();
  const actions: LauncherAction[] = [
    { id: "new-file", label: "New file", keys: "⌥⌘N", icon: FilePlus, run: newFile },
    { id: "source", label: "Source", keys: "⌃⇧G", icon: GitBranch, run: source },
  ];
  render(
    <WorkbenchLauncher rootDir="/repo" recent={recent} now={now} actions={actions} onGoToFile={onGoToFile} onOpen={onOpen} {...props} />,
  );
  return { onGoToFile, onOpen, newFile, source, field: screen.getByRole("combobox", { name: "Go to file" }) };
}

const rows = () => within(screen.getByRole("listbox", { name: "Recent files" })).getAllByRole("option");

/** Labels are written in Mac glyphs and printed for this machine; jsdom names no platform. */
function onPlatform(platform: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
}

describe("WorkbenchLauncher (EDITOR 02)", () => {
  beforeEach(() => onPlatform("MacIntel"));
  afterEach(() => vi.restoreAllMocks());

  it("leads with the Go to file field and its key", () => {
    const { field } = setup();
    expect(field).toHaveAttribute("placeholder", "Go to file…");
    expect(screen.getByText("⌘P")).toBeInTheDocument();
  });

  it("typing in the field hands the text to the palette", () => {
    const { field, onGoToFile } = setup();
    fireEvent.change(field, { target: { value: "u" } });
    expect(onGoToFile).toHaveBeenCalledWith("u");
    expect(field).toHaveValue("");
  });

  it("lists recent files newest first: name, folder, how long ago", () => {
    setup();
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["UserController.php", "web.php", "README.md"]);
    expect(within(rows()[0]).getByText("app/Http")).toBeInTheDocument();
    expect(within(rows()[0]).getByText("2 min")).toBeInTheDocument();
    expect(within(rows()[2]).getByText("2 d")).toBeInTheDocument();
  });

  it("↓ from the field highlights a row, which says ↵ open; Enter opens it", () => {
    const { field, onOpen } = setup();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(rows()[1]).toHaveAttribute("aria-selected", "true");
    expect(within(rows()[1]).getByText("↵ open")).toBeInTheDocument();
    expect(within(rows()[0]).getByText("2 min")).toBeInTheDocument();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("/repo/routes/web.php");
  });

  it("Enter with no row highlighted opens the palette", () => {
    const { field, onGoToFile, onOpen } = setup();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onGoToFile).toHaveBeenCalledWith("");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("a click opens a recent file", () => {
    const { onOpen } = setup();
    fireEvent.click(rows()[2]);
    expect(onOpen).toHaveBeenCalledWith("/repo/README.md");
  });

  it("shows at most eight recent files, and no list when there are none", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ path: `/repo/f${index}.ts`, at: now - index }));
    const { unmount } = render(
      <WorkbenchLauncher rootDir="/repo" recent={many} now={now} actions={[]} onGoToFile={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(within(screen.getByRole("listbox", { name: "Recent files" })).getAllByRole("option")).toHaveLength(8);
    unmount();

    render(<WorkbenchLauncher rootDir="/repo" recent={[]} now={now} actions={[]} onGoToFile={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByText(/No recent files/)).toBeInTheDocument();
  });

  it("quick actions show their keys and run", () => {
    const { newFile, source } = setup();
    const newFileButton = screen.getByRole("button", { name: /New file/ });
    expect(newFileButton).toHaveTextContent("⌥⌘N");
    fireEvent.click(newFileButton);
    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    expect(newFile).toHaveBeenCalled();
    expect(source).toHaveBeenCalled();
  });

  it("prints the keys as a Windows keyboard names them", () => {
    onPlatform("Win32");
    setup();
    expect(screen.getByText("Ctrl+P")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New file/ })).toHaveTextContent("Ctrl+Alt+N");
    expect(screen.getByRole("button", { name: /Source/ })).toHaveTextContent("Ctrl+Shift+G");
  });

  it("says an age once for a run of rows with the same one", () => {
    const same = [
      { path: "/repo/a.ts", at: now - 60_000 * 19 },
      { path: "/repo/b.ts", at: now - 60_000 * 19 },
      { path: "/repo/c.ts", at: now - 60_000 * 90 },
    ];
    render(<WorkbenchLauncher rootDir="/repo" recent={same} now={now} actions={[]} onGoToFile={vi.fn()} onOpen={vi.fn()} />);
    const [a, b, c] = within(screen.getByRole("listbox", { name: "Recent files" })).getAllByRole("option");
    expect(within(a).getByText("19 min")).toBeInTheDocument();
    expect(within(b).queryByText("19 min")).not.toBeInTheDocument();
    expect(within(c).getByText("1 h")).toBeInTheDocument();
  });
});

