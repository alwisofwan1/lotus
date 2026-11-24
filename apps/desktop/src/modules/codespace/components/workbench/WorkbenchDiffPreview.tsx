"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { useMonaco } from "@monaco-editor/react";
import { useTheme } from "@/contexts/ThemeContext";
import { resolveEditorLanguage } from "@/modules/codespace/services/editor-languages";
import { applyCodespaceMonacoTheme, defineCodespaceMonacoThemes, ensureCodespaceLanguage, getCodespaceMonacoDiffThemeName } from "@/modules/codespace/services/monaco-theme";
import { DEFAULT_EDITOR_FONT_SIZE, editorLineHeight } from "@/modules/codespace/services/editor-preferences";
import { formatPathRange, type DiffLineChange, type DiffSide } from "@/modules/codespace/services/selection-payload";
import {
  readLineSelection,
  SelectionPopover,
  useSelectionPopover,
  type EditorLineSelection,
  type SelectionAction,
  sendSelectionKeybinding,
} from "./SelectionPopover";

/** A selection in one side of the diff, with what is needed to cut a patch from it. */
export interface DiffEditorSelection extends EditorLineSelection {
  side: DiffSide;
  original: string;
  modified: string;
  changes: DiffLineChange[];
}

export interface WorkbenchDiffPreviewProps {
  content: string;
  originalContent: string;
  modifiedContent: string;
  originalPath: string;
  modifiedPath: string;
  filePath: string | null;
  renderSideBySide: boolean;
  loading: boolean;
  error: string | null;
  emptyLabel: string;
  /** Code font size in px, as the editor's. */
  fontSize?: number;
  /** Shown in the popover's Copy button (`path:N-M`). */
  displayPath?: string;
  /** ⌘L, the popover or the context menu in either side. Absent, none of those are offered. */
  onSelectionAction?: (action: SelectionAction, selection: DiffEditorSelection) => void;
}

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((module) => module.DiffEditor),
  {
    ssr: false,
    loading: () => (
      <div className="codespace-workbench-editor grid h-full place-items-center text-[11px] text-[color:var(--codespace-panel-text-muted)]">
        Loading diff...
      </div>
    ),
  },
);

type MonacoApi = typeof import("monaco-editor");

export function WorkbenchDiffPreview({
  content,
  originalContent,
  modifiedContent,
  originalPath,
  modifiedPath,
  filePath,
  renderSideBySide,
  loading,
  error,
  emptyLabel,
  fontSize = DEFAULT_EDITOR_FONT_SIZE,
  displayPath,
  onSelectionAction,
}: WorkbenchDiffPreviewProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [diffEditor, setDiffEditor] = useState<MonacoEditorNS.IStandaloneDiffEditor | null>(null);
  const onSelectionActionRef = useRef(onSelectionAction);
  useEffect(() => {
    onSelectionActionRef.current = onSelectionAction;
  }, [onSelectionAction]);
  const offered = Boolean(onSelectionAction);
  const originalPopover = useSelectionPopover(offered ? diffEditor?.getOriginalEditor() ?? null : null, containerRef);
  const modifiedPopover = useSelectionPopover(offered ? diffEditor?.getModifiedEditor() ?? null : null, containerRef);

  const readDiffSelection = useCallback((
    instance: MonacoEditorNS.IStandaloneDiffEditor,
    side: DiffSide,
  ): DiffEditorSelection | null => {
    const sideEditor = side === "original" ? instance.getOriginalEditor() : instance.getModifiedEditor();
    const selection = readLineSelection(sideEditor);
    if (!selection) return null;
    return {
      ...selection,
      side,
      original: instance.getOriginalEditor().getValue(),
      modified: instance.getModifiedEditor().getValue(),
      changes: (instance.getLineChanges() ?? []).map((change) => ({
        originalStartLineNumber: change.originalStartLineNumber,
        originalEndLineNumber: change.originalEndLineNumber,
        modifiedStartLineNumber: change.modifiedStartLineNumber,
        modifiedEndLineNumber: change.modifiedEndLineNumber,
      })),
    };
  }, []);

  const handleMount = useCallback((instance: MonacoEditorNS.IStandaloneDiffEditor, monacoApi: MonacoApi) => {
    setDiffEditor(instance);
    // A layout switch or a reload remounts the diff; the popovers must not hold the old one.
    instance.getModifiedEditor().onDidDispose(() => setDiffEditor((current) => (current === instance ? null : current)));
    const sides: Array<[DiffSide, MonacoEditorNS.IStandaloneCodeEditor]> = [
      ["original", instance.getOriginalEditor()],
      ["modified", instance.getModifiedEditor()],
    ];
    for (const [side, sideEditor] of sides) {
      const run = (action: SelectionAction) => {
        const handler = onSelectionActionRef.current;
        const selection = readDiffSelection(instance, side);
        if (handler && selection) handler(action, selection);
      };
      sideEditor.addAction({
        id: "lotus.sendSelectionToThread",
        label: "Send to Thread",
        keybindings: sendSelectionKeybinding(monacoApi),
        contextMenuGroupId: "0_lotus",
        contextMenuOrder: 1,
        run: () => run("send"),
      });
      sideEditor.addAction({
        id: "lotus.askAboutSelection",
        label: "Ask About This",
        contextMenuGroupId: "0_lotus",
        contextMenuOrder: 2,
        precondition: "editorHasSelection",
        run: () => run("ask"),
      });
    }
  }, [readDiffSelection]);
  const monaco = useMonaco();
  const language = resolveEditorLanguage(filePath);

  const handleBeforeMount = useCallback((monaco: MonacoApi) => {
    defineCodespaceMonacoThemes(monaco, theme);
  }, [theme]);

  useEffect(() => {
    if (!monaco) return;
    void applyCodespaceMonacoTheme(monaco, theme);
  }, [monaco, theme]);

  useEffect(() => {
    if (monaco) void ensureCodespaceLanguage(monaco, language);
  }, [language, monaco]);

  if (loading) {
    return (
      <div className="codespace-workbench-editor grid h-full place-items-center text-[11px] text-[color:var(--codespace-panel-text-muted)]">
        Loading diff...
      </div>
    );
  }

  if (error) {
    return (
      <div className="codespace-workbench-editor grid h-full place-items-center p-4 text-center">
        <div>
          <p className="text-xs font-semibold text-amber-100/80">Unable to load diff</p>
          <p className="mt-1 text-[11px] text-[color:var(--codespace-panel-text-muted)]">{error}</p>
        </div>
      </div>
    );
  }

  if (!content.trim() && !originalContent && !modifiedContent) {
    return (
      <div className="codespace-workbench-editor grid h-full place-items-center text-[11px] text-[color:var(--codespace-panel-text-muted)]">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="codespace-workbench-editor relative min-h-0 flex-1 overflow-hidden">
      <MonacoDiffEditor
        key={renderSideBySide ? "diff-split" : "diff-inline"}
        original={originalContent}
        modified={modifiedContent}
        language={language}
        originalModelPath={originalPath}
        modifiedModelPath={modifiedPath}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        theme={getCodespaceMonacoDiffThemeName(theme)}
        options={{
          readOnly: true,
          domReadOnly: true,
          renderSideBySide,
          useInlineViewWhenSpaceIsLimited: false,
          renderSideBySideInlineBreakpoint: 0,
          enableSplitViewResizing: true,
          ignoreTrimWhitespace: false,
          renderIndicators: true,
          originalEditable: false,
          minimap: { enabled: false },
          fontSize,
          lineHeight: editorLineHeight(fontSize),
          fontFamily: "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          smoothScrolling: true,
          scrollBeyondLastLine: false,
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: true,
          renderOverviewRuler: true,
          scrollbar: {
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
          },
          automaticLayout: true,
          wordWrap: "off",
          renderLineHighlight: "line",
          renderWhitespace: "none",
          occurrencesHighlight: "off",
          selectionHighlight: false,
          padding: {
            top: 12,
            bottom: 16,
          },
        }}
      />
      {diffEditor && onSelectionAction
        ? ([["original", originalPopover], ["modified", modifiedPopover]] as const).map(([side, popover]) => {
          if (!popover.position) return null;
          const selection = readDiffSelection(diffEditor, side);
          const label = displayPath ?? filePath ?? "";
          return (
            <SelectionPopover
              key={side}
              position={popover.position}
              lineLabel={selection ? formatPathRange(label, selection.startLine, selection.endLine) : label}
              onAction={(action) => {
                popover.hide();
                const current = readDiffSelection(diffEditor, side);
                if (current) onSelectionAction(action, current);
              }}
            />
          );
        })
        : null}
    </div>
  );
}
