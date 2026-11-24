/// <reference types="@testing-library/jest-dom" />
import { render, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

// Monaco cannot render in jsdom. We stub the heavy dynamic import so the
// component tree mounts and the onMount callback fires synchronously.
const modelState = vi.hoisted(() => ({ value: "" }));
const editorSpies = vi.hoisted(() => ({
  revealLinesInCenter: vi.fn(),
  setSelection: vi.fn(),
  createDecorationsCollection: vi.fn(() => ({ clear: vi.fn() })),
  pushEditOperations: vi.fn(),
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
        getValue: vi.fn(() => modelState.value || (defaultValue ?? "")),
        getFullModelRange: vi.fn(() => range),
        pushEditOperations: editorSpies.pushEditOperations,
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
  content: "saved on disk",
  loading: false,
  binary: false,
  error: null,
  dirty: false,
  onChange: vi.fn(),
  onSave: vi.fn(),
};

describe("WorkbenchEditor — keeps Monaco's text equal to the file's content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelState.value = "";
  });

  it("replaces a stale model left over from a closed tab", async () => {
    modelState.value = "zzz stale edit";
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} contentPath="/project/src/index.ts" />);
    });

    expect(editorSpies.pushEditOperations).toHaveBeenCalledWith(
      [],
      [expect.objectContaining({ text: "saved on disk" })],
      expect.any(Function),
    );
  });

  it("leaves the model alone when it already holds the content", async () => {
    modelState.value = "saved on disk";
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} contentPath="/project/src/index.ts" />);
    });
    expect(editorSpies.pushEditOperations).not.toHaveBeenCalled();
  });

  it("does not push content that belongs to another file", async () => {
    modelState.value = "zzz stale edit";
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} contentPath="/project/src/other.ts" />);
    });
    expect(editorSpies.pushEditOperations).not.toHaveBeenCalled();
  });
});
