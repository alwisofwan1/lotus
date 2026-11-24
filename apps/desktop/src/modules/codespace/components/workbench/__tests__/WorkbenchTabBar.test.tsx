import { createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { WorkbenchTab } from "../../types";
import { WorkbenchTabBar } from "../WorkbenchTabBar";

const tabs: WorkbenchTab[] = [
  { id: "a", kind: "file", filePath: "/r/src/a.ts" },
  { id: "b", kind: "file", filePath: "/r/src/b.ts" },
  { id: "c", kind: "file", filePath: "/r/src/c.ts" },
];

const menuItems = () => within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent);

function renderBar(props: Partial<Parameters<typeof WorkbenchTabBar>[0]> = {}) {
  const onCloseTabs = vi.fn();
  const view = render(
    <WorkbenchTabBar
      tabs={tabs}
      activeTabId="a"
      onSelectTab={vi.fn()}
      onCloseTab={vi.fn()}
      onCloseTabs={onCloseTabs}
      onNewUrlTab={vi.fn()}
      onPinTab={vi.fn()}
      {...props}
    />,
  );
  return { ...view, onCloseTabs };
}

function setStripGeometry(strip: HTMLElement, { scrollLeft, scrollWidth, clientWidth }: Record<string, number>) {
  Object.defineProperty(strip, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(strip, "clientWidth", { configurable: true, value: clientWidth });
  strip.scrollLeft = scrollLeft;
}

describe("WorkbenchTabBar menu (E26)", () => {
  const writeText = vi.fn();
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  it("right-click on a tab opens Close, Close others, Close to the right, Pin, Copy path", () => {
    renderBar();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /b\.ts/ }));
    expect(menuItems()).toEqual(["Close", "Close others", "Close to the right", "Pin", "Copy path"]);
  });

  it("leaves out the items that would do nothing", () => {
    renderBar({ tabs: [tabs[0]] });
    fireEvent.contextMenu(screen.getByRole("tab", { name: /a\.ts/ }));
    expect(menuItems()).toEqual(["Close", "Pin", "Copy path"]);
  });

  it.each([
    ["Close", "one"],
    ["Close others", "others"],
    ["Close to the right", "right"],
  ])("%s asks the pane to close with scope %s", (label, scope) => {
    const { onCloseTabs } = renderBar();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /b\.ts/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
    expect(onCloseTabs).toHaveBeenCalledWith("b", scope);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Copy path writes the file's full path", () => {
    renderBar();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /c\.ts/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith("/r/src/c.ts");
  });
});

describe("WorkbenchTabBar overflow (E27)", () => {
  it("has no fade while every tab fits", () => {
    renderBar();
    const strip = screen.getByRole("tablist");
    setStripGeometry(strip, { scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
    fireEvent.scroll(strip);
    expect(strip.dataset.fadeStart).toBeUndefined();
    expect(strip.dataset.fadeEnd).toBeUndefined();
  });

  it("fades only the edges that have hidden tabs behind them", () => {
    renderBar();
    const strip = screen.getByRole("tablist");
    setStripGeometry(strip, { scrollLeft: 0, scrollWidth: 900, clientWidth: 300 });
    fireEvent.scroll(strip);
    expect(strip.dataset.fadeStart).toBeUndefined();
    expect(strip.dataset.fadeEnd).toBe("true");

    setStripGeometry(strip, { scrollLeft: 600, scrollWidth: 900, clientWidth: 300 });
    fireEvent.scroll(strip);
    expect(strip.dataset.fadeStart).toBe("true");
    expect(strip.dataset.fadeEnd).toBeUndefined();
  });

  it("turns a vertical wheel into horizontal scrolling", () => {
    renderBar();
    const strip = screen.getByRole("tablist");
    setStripGeometry(strip, { scrollLeft: 0, scrollWidth: 900, clientWidth: 300 });
    fireEvent.wheel(strip, { deltaY: 120, deltaX: 0 });
    expect(strip.scrollLeft).toBe(120);
  });

  it("scrolls the active tab into view when it changes", () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    const view = renderBar();
    scrollIntoView.mockClear();
    view.rerender(
      <WorkbenchTabBar
        tabs={tabs}
        activeTabId="c"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onCloseTabs={vi.fn()}
        onNewUrlTab={vi.fn()}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole("tab", { name: /c\.ts/ }).parentElement);
  });

  it("keeps pane actions outside the scrolling list", () => {
    renderBar({ trailing: <button type="button">Go to file</button> });
    expect(within(screen.getByRole("tablist")).queryByRole("button", { name: "Go to file" })).toBeNull();
    expect(screen.getByRole("button", { name: "Go to file" })).toBeTruthy();
  });
});

describe("WorkbenchTabBar diff tab (E28)", () => {
  const diffTabs: WorkbenchTab[] = [
    { id: "a", kind: "file", filePath: "/r/src/a.ts" },
    { id: "diff:/r/src/a.ts", kind: "diff", filePath: "/r/src/a.ts", target: "unstaged" },
  ];

  it("labels it `file · diff` and gives it a close button", () => {
    const onCloseTab = vi.fn();
    renderBar({ tabs: diffTabs, activeTabId: "diff:/r/src/a.ts", onCloseTab });
    expect(screen.getByRole("tab", { name: "a.ts · diff" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close a.ts · diff" }));
    expect(onCloseTab).toHaveBeenCalledWith("diff:/r/src/a.ts");
  });

  it("copies the file's path from its menu", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    onTestFinished(() => {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    });
    renderBar({ tabs: diffTabs, activeTabId: "a" });
    fireEvent.contextMenu(screen.getByRole("tab", { name: "a.ts · diff" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy path/ }));
    expect(writeText).toHaveBeenCalledWith("/r/src/a.ts");
  });
});

/** jsdom has no DragEvent, so the pointer position is set on the event by hand. */
function dragAt(kind: "dragOver" | "drop", element: HTMLElement, clientX: number, dataTransfer: object) {
  const event = createEvent[kind](element, { dataTransfer });
  Object.defineProperty(event, "clientX", { value: clientX });
  fireEvent(element, event);
}

describe("WorkbenchTabBar tabs batch (LOT2-210)", () => {
  it("middle-click closes the tab", () => {
    const onCloseTab = vi.fn();
    renderBar({ onCloseTab });
    fireEvent(screen.getByRole("tab", { name: /b\.ts/ }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(onCloseTab).toHaveBeenCalledWith("b");
  });

  it("middle-click leaves a pinned tab open", () => {
    const onCloseTab = vi.fn();
    renderBar({ tabs: [{ ...tabs[0], pinned: true } as WorkbenchTab], onCloseTab });
    fireEvent(screen.getByRole("tab", { name: /a\.ts/ }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it("a right-button auxclick does not close", () => {
    const onCloseTab = vi.fn();
    renderBar({ onCloseTab });
    fireEvent(screen.getByRole("tab", { name: /b\.ts/ }), new MouseEvent("auxclick", { bubbles: true, button: 2 }));
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it("shows a preview tab in italics and keeps it on double-click", () => {
    const onKeepTab = vi.fn();
    renderBar({ tabs: [{ ...tabs[0], preview: true } as WorkbenchTab, tabs[1]], onKeepTab });
    const tab = screen.getByRole("tab", { name: /a\.ts/ });
    expect(tab.closest("[data-tab-id]")).toHaveAttribute("data-preview", "true");
    fireEvent.doubleClick(tab);
    expect(onKeepTab).toHaveBeenCalledWith("a");
  });

  it("Pin and Unpin come from the tab's menu", () => {
    const onPinTab = vi.fn();
    renderBar({ tabs: [{ ...tabs[0], pinned: true } as WorkbenchTab, tabs[1]], onPinTab });
    fireEvent.contextMenu(screen.getByRole("tab", { name: /b\.ts/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(onPinTab).toHaveBeenCalledWith("b", true);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /a\.ts/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(onPinTab).toHaveBeenCalledWith("a", false);
  });

  it("a pinned tab's button unpins instead of closing", () => {
    const onPinTab = vi.fn();
    const onCloseTab = vi.fn();
    renderBar({ tabs: [{ ...tabs[0], pinned: true } as WorkbenchTab], onPinTab, onCloseTab });
    fireEvent.click(screen.getByRole("button", { name: "Unpin a.ts" }));
    expect(onPinTab).toHaveBeenCalledWith("a", false);
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it("Split right is offered only when the pane can split, and only for files", () => {
    const onSplitTab = vi.fn();
    const { unmount } = renderBar();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /a\.ts/ }));
    expect(menuItems()).not.toContain("Split right");
    unmount();
    renderBar({ onSplitTab, canSplit: () => false });
    fireEvent.contextMenu(screen.getByRole("tab", { name: /a\.ts/ }));
    expect(menuItems()).not.toContain("Split right");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    renderBar({ onSplitTab, canSplit: () => true });
    fireEvent.contextMenu(screen.getAllByRole("tab", { name: /a\.ts/ }).at(-1) as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "Split right" }));
    expect(onSplitTab).toHaveBeenCalledWith("a");
  });

  it("shows the folder beside same-name tabs", () => {
    renderBar({
      tabs: [
        { id: "x", kind: "file", filePath: "/r/src/index.ts" },
        { id: "y", kind: "file", filePath: "/r/lib/index.ts" },
      ],
      activeTabId: "x",
    });
    expect(screen.getByRole("tab", { name: /index\.ts\s*in\s*src/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /index\.ts\s*in\s*lib/ })).toBeInTheDocument();
  });

  it("dropping a dragged tab on the left half of another puts it before that one", () => {
    const onMoveTab = vi.fn();
    renderBar({ onMoveTab });
    const source = screen.getByRole("tab", { name: /c\.ts/ }).closest("[data-tab-id]") as HTMLElement;
    const target = screen.getByRole("tab", { name: /a\.ts/ }).closest("[data-tab-id]") as HTMLElement;
    target.getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON: () => ({}) });
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(source, { dataTransfer });
    // Not text: dropped on a terminal or the editor, a tab must not type its path.
    expect(dataTransfer.setData).toHaveBeenCalledWith("application/x-lotus-editor-tab", "c");
    expect(dataTransfer.setData).not.toHaveBeenCalledWith("text/plain", expect.anything());
    dragAt("dragOver", target, 10, dataTransfer);
    dragAt("drop", target, 10, dataTransfer);
    expect(onMoveTab).toHaveBeenCalledWith("c", 0);
  });

  it("dropping on the right half puts it after", () => {
    const onMoveTab = vi.fn();
    renderBar({ onMoveTab });
    const source = screen.getByRole("tab", { name: /a\.ts/ }).closest("[data-tab-id]") as HTMLElement;
    const target = screen.getByRole("tab", { name: /b\.ts/ }).closest("[data-tab-id]") as HTMLElement;
    target.getBoundingClientRect = () => ({ left: 100, width: 100, right: 200, top: 0, bottom: 20, height: 20, x: 100, y: 0, toJSON: () => ({}) });
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(source, { dataTransfer });
    dragAt("drop", target, 190, dataTransfer);
    // Without a, b sits at 0, so after it is 1.
    expect(onMoveTab).toHaveBeenCalledWith("a", 1);
  });
});
