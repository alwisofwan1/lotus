/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * ⌘L, its popover and the context menu (LOT2-60). Monaco cannot render in jsdom, so the editor
 * is a stub holding a selection of lines 10-12 and recording the listeners the popover adds.
 */

type Listener = (event?: unknown) => void;
const listeners: Record<string, Listener[]> = {};
const actions: Array<{ id: string; keybindings?: number[]; run: () => void }> = [];
const LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
const selection = {
  startLineNumber: 10,
  startColumn: 3,
  endLineNumber: 12,
  endColumn: 5,
  isEmpty: () => false,
  getPosition: () => ({ lineNumber: 12, column: 5 }),
};

vi.mock("@monaco-editor/react", async () => {
  const { useEffect } = await import("react");
  const on = (name: string) => (listener: Listener) => {
    (listeners[name] ??= []).push(listener);
    return { dispose: () => { listeners[name] = listeners[name].filter((entry) => entry !== listener); } };
  };
  function MonacoEditor({ onMount }: { onMount?: (editor: unknown, monaco: unknown) => void }) {
    useEffect(() => {
      const model = {
        getValue: () => LINES.join("\n"),
        getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 20, endColumn: 8 }),
        pushEditOperations: vi.fn(),
        getLineMaxColumn: (line: number) => LINES[line - 1].length + 1,
        getValueInRange: (range: { startLineNumber: number; endLineNumber: number }) =>
          LINES.slice(range.startLineNumber - 1, range.endLineNumber).join("\n"),
      };
      const editor = {
        getModel: () => model,
        getSelection: () => selection,
        getDomNode: () => document.createElement("div"),
        getScrolledVisiblePosition: () => ({ top: 40, left: 60, height: 18 }),
        pushUndoStop: vi.fn(),
        focus: vi.fn(),
        trigger: vi.fn(),
        addAction: (action: (typeof actions)[number]) => actions.push(action),
        onMouseDown: on("mouseDown"),
        onMouseUp: on("mouseUp"),
        onDidChangeCursorSelection: on("selection"),
        onDidScrollChange: on("scroll"),
        onKeyDown: on("keyDown"),
        onDidBlurEditorText: on("blur"),
        onDidChangeModel: on("model"),
      };
      onMount?.(editor, { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyL: 42 } });
    }, [onMount]);
    return <div data-testid="monaco-editor" />;
  }
  return { default: MonacoEditor, useMonaco: () => null };
});

vi.mock("@/contexts/ThemeContext", () => ({ useTheme: () => ({ theme: { type: "dark" } }) }));
vi.mock("@/lib/tauri-api", () => ({ getSettings: vi.fn().mockResolvedValue(null) }));
vi.mock("@/modules/settings/services/settings-events", () => ({
  LOTUS_SETTINGS_CHANGED_EVENT: "lotus-settings-changed",
  readLotusSettingsChangedDetail: vi.fn(() => null),
}));
vi.mock("@/modules/codespace/services/monaco-theme", () => ({
  getCodespaceMonacoThemeName: vi.fn(() => "dark-theme"),
  applyCodespaceMonacoTheme: vi.fn().mockResolvedValue(undefined),
  ensureCodespaceLanguage: vi.fn(),
}));
vi.mock("@/lib/fonts", () => ({ detectMonoFontFamily: vi.fn(() => "monospace") }));

import { WorkbenchEditor } from "../WorkbenchEditor";

const baseProps = {
  filePath: "/project/src/x.ts",
  rootDir: "/project",
  content: LINES.join("\n"),
  loading: false,
  binary: false,
  error: null,
  dirty: false,
  onChange: vi.fn(),
  onSave: vi.fn(),
};

const emit = (name: string, event?: unknown) => act(() => {
  for (const listener of listeners[name] ?? []) listener(event);
});

describe("WorkbenchEditor — hand a selection on (⌘L)", () => {
  beforeEach(() => {
    actions.length = 0;
    for (const key of Object.keys(listeners)) delete listeners[key];
    // Keycaps are printed for this machine's keyboard; jsdom names no platform, so pin macOS.
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("⌘L sends the whole selected lines, bound over Monaco's own ⌘L", async () => {
    const onSelectionAction = vi.fn();
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} onSelectionAction={onSelectionAction} />);
    });

    const send = actions.find((action) => action.id === "lotus.sendSelectionToThread");
    expect(send?.keybindings).toEqual([2048 | 42]);
    send?.run();
    expect(onSelectionAction).toHaveBeenCalledWith("send", {
      startLine: 10,
      endLine: 12,
      code: "line 10\nline 11\nline 12",
    });
    expect(actions.map((action) => action.id)).toContain("lotus.askAboutSelection");
  });

  it("shows three actions once the mouse is released, and Esc hides them", async () => {
    const onSelectionAction = vi.fn();
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} onSelectionAction={onSelectionAction} />);
    });

    emit("mouseDown");
    emit("mouseUp");
    act(() => vi.advanceTimersByTime(200));
    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    expect(Array.from(toolbar.querySelectorAll("button"), (button) => button.textContent)).toEqual([
      "Send to Thread⌘L",
      "Ask about this",
      "Copy path",
    ]);
    expect(screen.getByRole("button", { name: /Copy path/ })).toHaveAttribute("title", "Copy src/x.ts:10-12");

    emit("keyDown", { browserEvent: { key: "Escape" } });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("a popover button hands the selection on and closes", async () => {
    const onSelectionAction = vi.fn();
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} onSelectionAction={onSelectionAction} />);
    });
    emit("mouseUp");
    act(() => vi.advanceTimersByTime(200));

    fireEvent.click(screen.getByRole("button", { name: /Ask about this/ }));
    expect(onSelectionAction).toHaveBeenCalledWith("ask", expect.objectContaining({ startLine: 10, endLine: 12 }));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("offers nothing without a handler", async () => {
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} />);
    });
    emit("mouseUp");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });
});
