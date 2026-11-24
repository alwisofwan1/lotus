import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoToFilePalette, type PaletteCommand } from "../GoToFilePalette";

const root = "/repo";
const files = ["/repo/app/Http/UserController.php", "/repo/routes/web.php", "/repo/README.md"];
const now = new Date("2026-09-29T15:00:00").getTime();
const recent = [
  { path: "/repo/app/Http/UserController.php", at: now - 60_000 * 3 },
  { path: "/repo/routes/web.php", at: now - 60_000 * 14 },
];

function setup(props: Partial<Parameters<typeof GoToFilePalette>[0]> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  render(
    <GoToFilePalette rootDir={root} files={files} truncated={false} recent={recent} now={now} onOpen={onOpen} onClose={onClose} {...props} />,
  );
  return { onOpen, onClose, input: screen.getByRole("combobox", { name: "Go to file" }) };
}

const options = () => within(screen.getByRole("listbox")).queryAllByRole("option");
const typeQuery = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

describe("GoToFilePalette recent files (E21)", () => {
  it("an empty query lists recent files, newest first, with how long ago", () => {
    setup();
    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(options().map((option) => option.getAttribute("aria-label"))).toEqual(["UserController.php", "web.php"]);
    // The highlighted row says what Enter does instead of its time.
    expect(within(options()[0]).getByText("↵ open")).toBeInTheDocument();
    expect(within(options()[1]).getByText("14 min")).toBeInTheDocument();
    expect(within(options()[1]).getByText("routes")).toBeInTheDocument();
  });

  it("opens a recent file with the keys", () => {
    const { input, onOpen } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(within(options()[1]).getByText("↵ open")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("/repo/routes/web.php", undefined);
  });

  it("shows at most eight", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ path: `/repo/f${index}.ts`, at: now - index }));
    setup({ recent: many });
    expect(options()).toHaveLength(8);
  });

  it("with nothing recent, invites a search", () => {
    setup({ recent: [] });
    expect(screen.getByText("Type to search 3 files")).toBeInTheDocument();
  });

  it("starts with the text typed before it opened", () => {
    const { input } = setup({ initialQuery: "web" });
    expect(input).toHaveValue("web");
    expect(options().map((option) => option.getAttribute("aria-label"))).toEqual(["web.php"]);
  });
});

describe("GoToFilePalette commands (E24)", () => {
  const commands = (): PaletteCommand[] => [
    { id: "save-all", label: "Save all", run: vi.fn() },
    { id: "toggle-wrap", label: "Toggle word wrap", hint: "⌥Z", run: vi.fn() },
    { id: "reveal", label: "Reveal in tree", run: vi.fn() },
  ];

  it("> lists the editor commands instead of files", () => {
    const { input } = setup({ commands: commands() });
    typeQuery(input, ">");
    expect(options().map((option) => option.getAttribute("aria-label"))).toEqual(["Save all", "Toggle word wrap", "Reveal in tree"]);
    expect(within(options()[1]).getByText("⌥Z")).toBeInTheDocument();
  });

  it("narrows them by what follows >, in any case", () => {
    const { input } = setup({ commands: commands() });
    typeQuery(input, "> WRAP");
    expect(options().map((option) => option.getAttribute("aria-label"))).toEqual(["Toggle word wrap"]);
    typeQuery(input, ">nothing");
    expect(screen.getByText("No command matches nothing")).toBeInTheDocument();
  });

  it("Enter runs the highlighted command and closes", () => {
    const list = commands();
    const onCommand = vi.fn();
    const { input, onOpen } = setup({ commands: list, onCommand });
    typeQuery(input, ">");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommand).toHaveBeenCalledWith(list[2]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("a click runs a command too", () => {
    const list = commands();
    const onCommand = vi.fn();
    const { input } = setup({ commands: list, onCommand });
    typeQuery(input, ">save");
    fireEvent.click(options()[0]);
    expect(onCommand).toHaveBeenCalledWith(list[0]);
  });

  it("the footer says > opens commands", () => {
    setup({ commands: commands() });
    expect(screen.getByText("commands")).toBeInTheDocument();
  });
});
