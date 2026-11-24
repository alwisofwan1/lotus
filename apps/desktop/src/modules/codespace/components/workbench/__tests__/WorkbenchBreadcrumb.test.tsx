import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchBreadcrumb } from "../WorkbenchBreadcrumb";

const rootDir = "/repo";
const filePath = "/repo/app/Http/UserController.php";
const listings: Record<string, Array<{ path: string; kind: "file" | "directory" }>> = {
  "/repo/app": [
    { path: "/repo/app/Http", kind: "directory" },
    { path: "/repo/app/Models", kind: "directory" },
    { path: "/repo/app/helpers.php", kind: "file" },
  ],
  "/repo/app/Http": [
    { path: "/repo/app/Http/UserController.php", kind: "file" },
    { path: "/repo/app/Http/Kernel.php", kind: "file" },
  ],
  "/repo/app/Models": [{ path: "/repo/app/Models/User.php", kind: "file" }],
};

function renderCrumb(overrides: Partial<Parameters<typeof WorkbenchBreadcrumb>[0]> = {}) {
  const props = {
    rootDir,
    filePath,
    listDirectory: vi.fn(async (dir: string) => listings[dir] ?? []),
    onOpenFile: vi.fn(),
    wordWrap: false,
    onToggleWordWrap: vi.fn(),
    ...overrides,
  };
  render(<WorkbenchBreadcrumb {...props} />);
  return props;
}

const crumbs = () => within(screen.getByRole("navigation", { name: "File path" })).getAllByRole("button").map((b) => b.textContent);

describe("WorkbenchBreadcrumb", () => {
  it("shows the path from the workspace root, and nothing that is not real", () => {
    renderCrumb();
    expect(crumbs()).toEqual(["app", "Http", "UserController.php"]);
    expect(screen.queryByText(/TS Ready/)).toBeNull();
  });

  it("a folder opens its entries; a file there opens it", async () => {
    const props = renderCrumb();
    fireEvent.click(screen.getByRole("button", { name: "app" }));

    const menu = await screen.findByRole("menu", { name: "app" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Http", "Models", "helpers.php"]);
    expect(props.listDirectory).toHaveBeenCalledWith("/repo/app");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "helpers.php" }));
    expect(props.onOpenFile).toHaveBeenCalledWith("/repo/app/helpers.php");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a folder in the list shows what is inside it", async () => {
    const props = renderCrumb();
    fireEvent.click(screen.getByRole("button", { name: "app" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Models" }));

    const menu = await screen.findByRole("menu", { name: "Models" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "User.php" }));
    expect(props.onOpenFile).toHaveBeenCalledWith("/repo/app/Models/User.php");
  });

  it("the file's own crumb lists the files beside it, the open one marked", async () => {
    renderCrumb();
    fireEvent.click(screen.getByRole("button", { name: "UserController.php" }));
    const menu = await screen.findByRole("menu", { name: "Http" });
    expect(within(menu).getByRole("menuitem", { name: "UserController.php" })).toHaveAttribute("aria-current", "true");
  });

  it("Escape closes the list", async () => {
    renderCrumb();
    fireEvent.click(screen.getByRole("button", { name: "Http" }));
    await screen.findByRole("menu");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says when a folder cannot be read", async () => {
    renderCrumb({ listDirectory: vi.fn(async () => { throw new Error("denied"); }) });
    fireEvent.click(screen.getByRole("button", { name: "app" }));
    expect(await screen.findByText("Cannot read this folder.")).toBeInTheDocument();
  });

  it("toggles word wrap", () => {
    const props = renderCrumb({ wordWrap: true });
    const wrap = screen.getByRole("button", { name: "Word wrap" });
    expect(wrap).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(wrap);
    expect(props.onToggleWordWrap).toHaveBeenCalledTimes(1);
  });
});
