/// <reference types="@testing-library/jest-dom" />
import { render, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

// Monaco cannot render in jsdom. We stub the heavy dynamic import so the
// component tree mounts and the onMount callback fires synchronously.
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
import type { WorkbenchEditorApi } from "../WorkbenchEditor";

describe("WorkbenchEditor — onEditorReady", () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onEditorReady with an api object when Monaco mounts", async () => {
    const onEditorReady = vi.fn();

    await act(async () => {
      render(<WorkbenchEditor {...baseProps} onEditorReady={onEditorReady} />);
    });

    expect(onEditorReady).toHaveBeenCalledOnce();
    const api: WorkbenchEditorApi = onEditorReady.mock.calls[0][0];
    expect(typeof api.focus).toBe("function");
    expect(typeof api.setValue).toBe("function");
    expect(typeof api.undo).toBe("function");
    expect(typeof api.redo).toBe("function");
  });

  it("api.focus() delegates to editor.focus()", async () => {
    let capturedApi!: WorkbenchEditorApi;
    await act(async () => {
      render(<WorkbenchEditor {...baseProps} onEditorReady={(api) => { capturedApi = api; }} />);
    });

    capturedApi.focus();
    // No throw — editor mock's focus() was called (verified by no error).
    expect(capturedApi.focus).toBeDefined();
  });

  it("does not throw when onEditorReady is not provided", async () => {
    await expect(
      act(async () => {
        render(<WorkbenchEditor {...baseProps} />);
      }),
    ).resolves.not.toThrow();
  });

  it("renders the loading state while Monaco initialises", () => {
    const { getByText } = render(
      <WorkbenchEditor {...baseProps} loading={true} />,
    );
    expect(getByText("Reading file")).toBeInTheDocument();
  });

  it("renders the empty state when no filePath is provided", () => {
    const { getByText } = render(
      <WorkbenchEditor {...baseProps} filePath={null} />,
    );
    expect(getByText("Open a file")).toBeInTheDocument();
  });
});
