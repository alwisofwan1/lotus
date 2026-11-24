/// <reference types="@testing-library/jest-dom" />
import { render, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

// Monaco cannot render in jsdom. We stub the heavy dynamic import so the
// component tree mounts and the onMount callback fires synchronously.
const editorSpies = vi.hoisted(() => ({
  revealLinesInCenter: vi.fn(),
  setSelection: vi.fn(),
  createDecorationsCollection: vi.fn(() => ({ clear: vi.fn() })),
}));

vi.mock("@monaco-editor/react", async () => {
  const { forwardRef, useEffect } = await import("react");
  const MonacoEditor = forwardRef<unknown, {
    onMount?: (editor: unknown, monaco: unknown) => void;
    defaultValue?: string;
  }>(function MonacoEditor({ onMount, defaultValue }) {
    // Runs once on mount — simulates Monaco's synchronous onMount invocation.
    useEffect(() => {
      if (!onMount) return;
      const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
      const mockModel = {
        getLineMaxColumn: vi.fn(() => 30),
        getLineCount: vi.fn(() => 50),
        getValue: vi.fn(() => defaultValue ?? ""),
        getFullModelRange: vi.fn(() => range),
        pushEditOperations: vi.fn(),
      };
      const mockEditor = {
        getModel: vi.fn(() => mockModel),
        pushUndoStop: vi.fn(),
        focus: vi.fn(),
        trigger: vi.fn(),
        addAction: vi.fn(),
        revealLinesInCenter: editorSpies.revealLinesInCenter,
        setSelection: editorSpies.setSelection,
        createDecorationsCollection: editorSpies.createDecorationsCollection,
      };
      onMount(mockEditor, {});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="monaco-editor" />;
  });
  return { default: MonacoEditor, useMonaco: () => null };
});

// Silence theme / settings side-effects.
vi.mock("@/contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: { type: "dark" } }),
}));
vi.mock("@/lib/tauri-api", () => ({ getSettings: vi.fn().mockResolvedValue(null) }));
vi.mock("@/modules/settings/services/settings-events", () => ({
  LOTUS_SETTINGS_CHANGED_EVENT: "lotus-settings-changed",
  readLotusSettingsChangedDetail: vi.fn(() => null),
}));
vi.mock("@/modules/codespace/services/monaco-theme", () => ({
  getCodespaceMonacoThemeName: vi.fn(() => "dark-theme"),
  applyCodespaceMonacoTheme: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/modules/codespace/services/editor-languages", () => ({
  resolveEditorLanguage: vi.fn(() => "typescript"),
}));
vi.mock("@/lib/fonts", () => ({ detectMonoFontFamily: vi.fn(() => "monospace") }));

import { WorkbenchEditor } from "../WorkbenchEditor";

const baseProps = {
  filePath: "/project/src/index.ts",
  rootDir: "/project",
  content: "const x = 1;",
  loading: false,
  binary: false,
  error: null,
  dirty: false,
  onChange: vi.fn(),
  onSave: vi.fn(),
};

describe("WorkbenchEditor — reveal a line range", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scrolls to, selects and highlights the range when the editor mounts", async () => {
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} revealRange={{ startLine: 10, endLine: 12, nonce: 1 }} />);
    });

    expect(editorSpies.revealLinesInCenter).toHaveBeenCalledWith(10, 12);
    expect(editorSpies.setSelection).toHaveBeenCalledWith({
      startLineNumber: 10,
      startColumn: 1,
      endLineNumber: 12,
      endColumn: 30,
    });
    expect(editorSpies.createDecorationsCollection).toHaveBeenCalledWith([
      expect.objectContaining({
        range: { startLineNumber: 10, startColumn: 1, endLineNumber: 12, endColumn: 1 },
        options: expect.objectContaining({ isWholeLine: true }),
      }),
    ]);
  });

  it("reveals again when a new request arrives for the open file", async () => {
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      ({ rerender } = render(<WorkbenchEditor {...baseProps} revealRange={{ startLine: 3, endLine: 3, nonce: 1 }} />));
    });
    await act(async () => {
      rerender(<WorkbenchEditor {...baseProps} revealRange={{ startLine: 40, endLine: 41, nonce: 2 }} />);
    });

    expect(editorSpies.revealLinesInCenter).toHaveBeenLastCalledWith(40, 41);
    expect(editorSpies.revealLinesInCenter).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a range", async () => {
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} />);
    });
    expect(editorSpies.revealLinesInCenter).not.toHaveBeenCalled();
  });

  it("keeps the range inside the file instead of throwing", async () => {
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} revealRange={{ startLine: 0, endLine: 500, nonce: 1 }} />);
    });
    expect(editorSpies.revealLinesInCenter).toHaveBeenCalledWith(1, 50);
  });

  it("waits for the file to load before revealing, then reveals once", async () => {
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      ({ rerender } = render(<WorkbenchEditor {...baseProps} loading revealRange={{ startLine: 7, endLine: 7, nonce: 1 }} />));
    });
    expect(editorSpies.revealLinesInCenter).not.toHaveBeenCalled();

    await act(async () => {
      rerender(<WorkbenchEditor {...baseProps} revealRange={{ startLine: 7, endLine: 7, nonce: 1 }} />);
    });
    expect(editorSpies.revealLinesInCenter).toHaveBeenCalledTimes(1);
    expect(editorSpies.revealLinesInCenter).toHaveBeenCalledWith(7, 7);
  });
});
