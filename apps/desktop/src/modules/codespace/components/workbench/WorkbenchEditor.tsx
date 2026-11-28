"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMonaco } from "@monaco-editor/react";
import { AlertTriangle, FileCode2, Loader2, Save } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { detectMonoFontFamily } from "@/lib/fonts";
import * as path from "@/lib/path-utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { applyExternalContent } from "@/modules/codespace/services/editor-content-sync";
import { formatByteSize } from "@/modules/codespace/services/editor-media";
import { disposeDetachedEditorModel, installEditorModelReaper } from "@/modules/codespace/services/editor-models";
import { resolveEditorLanguage } from "@/modules/codespace/services/editor-languages";
import { applyCodespaceMonacoTheme, ensureCodespaceLanguage, getCodespaceMonacoThemeName } from "@/modules/codespace/services/monaco-theme";
import { watchEditorStatus, type EditorStatus } from "@/modules/codespace/services/editor-status";
import { attachLspModel, setLspEditorOpener, type LspPlace } from "@/modules/codespace/services/lsp/lsp-manager";
import { useEditorPreferences } from "@/modules/codespace/hooks/useEditorPreferences";
import { DEFAULT_EDITOR_FONT_SIZE, editorLineHeight } from "@/modules/codespace/services/editor-preferences";
import type { EditorConfig } from "@/modules/codespace/services/editor-config";
import { tidyEdits, type SaveTidy } from "@/modules/codespace/services/editor-save-tidy";
import { computeLineChanges } from "@/modules/codespace/services/editor-line-diff";
import type { editor as MonacoEditorNS } from "monaco-editor";
import type { GitBlameEntry } from "@/lib/tauri/project-files";
import { BLAME_DELAY_MS, blameAt, blameHover, blameInline } from "@/modules/codespace/services/inline-blame";
import { formatPathRange } from "@/modules/codespace/services/selection-payload";
import {
  readLineSelection,
  SelectionPopover,
  useSelectionPopover,
  type EditorLineSelection,
  type SelectionAction,
  sendSelectionKeybinding,
} from "./SelectionPopover";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

export interface WorkbenchEditorApi {
  focus(): void;
  undo(): void;
  redo(): void;
  /** Sync externally sourced content without clearing the undo stack. */
  setValue(content: string): void;
  /** Moves to the next error or warning in the file and shows it (F8). */
  showNextProblem(): void;
  /** Changes the file's line endings (an edit: the file is unsaved after). */
  setEndOfLine(eol: "LF" | "CRLF"): void;
  /**
   * Gets the shown file ready for ⌘S: formats it (when asked and a formatter is there), sets its
   * line endings, and tidies it. Each step is an edit, so ⌘Z takes it back.
   */
  prepareSave(options: EditorSaveSteps): Promise<void>;
}

export type EditorSaveSteps = {
  /** The file this is for: nothing happens if another one is shown now. */
  filePath: string;
  format: boolean;
  tidy: SaveTidy;
  endOfLine?: "LF" | "CRLF";
};

/** A formatter that does not answer in this long does not hold up the save. */
const FORMAT_ON_SAVE_TIMEOUT_MS = 2500;
/** Typing pauses this long before the git marks are worked out again. */
const GIT_GUTTER_DELAY_MS = 250;

export interface WorkbenchEditorProps {
  filePath: string | null;
  rootDir?: string | null;
  content: string;
  loading: boolean;
  binary: boolean;
  /**
   * Set when the file was not read because of its size. `onOpenAnyway` is there while it is
   * small enough to open past the cap (50 MB).
   */
  tooLarge?: { sizeBytes: number; onOpenAnyway: (() => void) | null } | null;
  error: string | null;
  dirty: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onEditorReady?: (api: WorkbenchEditorApi) => void;
  /**
   * The file `content` belongs to. Monaco keeps one model per path and reuses it when a tab is
   * reopened, so a model can outlive the edits that were discarded; when this matches `filePath`
   * the model is brought back to `content`.
   */
  contentPath?: string | null;
  /** Scroll to, select and briefly highlight these lines. A new `nonce` repeats it. */
  revealRange?: EditorRevealRange | null;
  /** Wrap long lines at the pane's width (Settings, the palette, the breadcrumb's wrap button). */
  wordWrap?: boolean;
  /** Code font size in px (Settings, or the palette's font size commands). */
  fontSize?: number;
  /** The cursor and indentation, for the status bar; `null` while no file is in the editor. */
  onStatusChange?: (status: EditorStatus | null) => void;
  /**
   * The selection was handed on — ⌘L, the popover, or the context menu. Absent, none of those
   * are offered.
   */
  onSelectionAction?: (action: SelectionAction, selection: EditorLineSelection) => void;
  /** Focus left the editor (its find box and menus are part of it): auto save on focus change. */
  onBlur?: () => void;
  /**
   * Language servers for this workspace: where it is, and whether one may run here (on in
   * Settings, folder trusted). Absent: none.
   */
  lsp?: { place: LspPlace; enabled: boolean; trusted: boolean } | null;
  /** Go to definition, or a peek, opened another file at this place. */
  onOpenLocation?: (path: string, range: { startLine: number; startColumn: number; endLine: number; endColumn: number }) => void;
  minimap?: boolean;
  stickyScroll?: boolean;
  /** The project's `.editorconfig` for `path`; applied only while that file is shown. */
  editorConfig?: { path: string; config: EditorConfig | null } | null;
  /**
   * Git's copy of `path` (the index, as VS Code), for the marks beside the line numbers. Absent or
   * `text: null`: no marks (a new file, or not in git).
   */
  gitBaseline?: { path: string; text: string | null } | null;
  /**
   * Who last changed each line of `path`, for the ghost text at the cursor line's end
   * (mockups/inline-blame.html). Hidden while `dirty`: unsaved edits move the lines.
   */
  blame?: { path: string; entries: readonly GitBlameEntry[] } | null;
}

export type EditorRevealRange = {
  startLine: number;
  endLine: number;
  nonce: number;
  /** A match on `startLine` (find in files): selected exactly instead of the whole lines. */
  startColumn?: number;
  endColumn?: number;
};

const REVEAL_HIGHLIGHT_MS = 2400;

/** Returns false when there is no model to reveal in, so the request stays pending. */
function revealLines(editorInstance: MonacoEditorNS.IStandaloneCodeEditor, range: EditorRevealRange): boolean {
  const model = editorInstance.getModel();
  if (!model) return false;
  // A link can name a line the file does not have (`x.ts:500`, `#L0`); Monaco throws on those.
  const lastLine = Math.max(1, model.getLineCount());
  const clamp = (line: number) => Math.min(lastLine, Math.max(1, Math.floor(line) || 1));
  const startLine = clamp(range.startLine);
  const endLine = Math.max(startLine, clamp(range.endLine));
  editorInstance.revealLinesInCenter(startLine, endLine);
  const maxColumn = model.getLineMaxColumn(endLine);
  const exact = range.startColumn !== undefined && range.endColumn !== undefined && startLine === endLine;
  editorInstance.setSelection(exact
    ? {
      startLineNumber: startLine,
      startColumn: Math.min(maxColumn, Math.max(1, range.startColumn ?? 1)),
      endLineNumber: endLine,
      endColumn: Math.min(maxColumn, Math.max(1, range.endColumn ?? maxColumn)),
    }
    : {
      startLineNumber: startLine,
      startColumn: 1,
      endLineNumber: endLine,
      endColumn: maxColumn,
    });
  const highlight = editorInstance.createDecorationsCollection([{
    range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
    options: { isWholeLine: true, className: "codespace-editor-reveal-line" },
  }]);
  window.setTimeout(() => highlight.clear(), REVEAL_HIGHLIGHT_MS);
  return true;
}

async function prepareSave(
  editorInstance: MonacoEditorNS.IStandaloneCodeEditor,
  steps: EditorSaveSteps,
  shownPath: { current: string | null },
): Promise<void> {
  const shown = () => shownPath.current === steps.filePath ? editorInstance.getModel() : null;
  if (!shown()) return;
  if (steps.format) {
    const action = editorInstance.getAction?.("editor.action.formatDocument");
    if (action?.isSupported()) {
      let timer = 0;
      await Promise.race([
        action.run().catch(() => {}),
        new Promise<void>((resolve) => {
          timer = window.setTimeout(resolve, FORMAT_ON_SAVE_TIMEOUT_MS);
        }),
      ]);
      window.clearTimeout(timer);
    }
  }
  // The file may have changed tabs while the formatter ran.
  const model = shown();
  if (!model) return;
  if (steps.endOfLine) {
    // 0 = LF, 1 = CRLF, in both EndOfLineSequence and EndOfLinePreference terms.
    const wanted = steps.endOfLine === "CRLF" ? 1 : 0;
    if (model.getEOL() !== (wanted === 1 ? "\r\n" : "\n")) model.pushEOL(wanted);
  }
  const edits = tidyEdits(model.getLinesContent(), model.getEOL(), steps.tidy);
  if (edits.length === 0) return;
  model.pushEditOperations(
    editorInstance.getSelections(),
    edits.map((edit) => ({
      range: { startLineNumber: edit.startLine, startColumn: edit.startColumn, endLineNumber: edit.endLine, endColumn: edit.endColumn },
      text: edit.text,
    })),
    () => null,
  );
  model.pushStackElement();
}

function popoverLineLabel(
  editorInstance: MonacoEditorNS.ICodeEditor,
  filePath: string,
  rootDir: string | null | undefined,
): string {
  const selection = readLineSelection(editorInstance);
  const shown = rootDir ? path.relative(rootDir, filePath) : filePath;
  return selection ? formatPathRange(shown, selection.startLine, selection.endLine) : shown;
}

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((module) => module.default),
  {
    ssr: false,
    loading: () => (
      <EditorState
        icon={<Loader2 className="h-4 w-4 animate-spin" />}
        title="Loading editor"
        description="Preparing Monaco for this workspace."
      />
    ),
  },
);

type MonacoApi = typeof import("monaco-editor");

type MonacoLanguagesWithTypescript = MonacoApi["languages"] & {
  typescript?: {
    typescriptDefaults?: { setDiagnosticsOptions: (options: Record<string, boolean>) => void };
    javascriptDefaults?: { setDiagnosticsOptions: (options: Record<string, boolean>) => void };
  };
};

function silenceMonacoTypeScriptDiagnostics(monaco: MonacoApi): void {
  // Monaco's TS/JS workers run without the project's tsconfig, so their
  // diagnostics (Cannot find module, etc.) are noise. Disable them so the
  // editor stays a pure code surface, not a type checker.
  const languages = monaco.languages as MonacoLanguagesWithTypescript;
  const diagnosticsOff = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  };
  languages.typescript?.typescriptDefaults?.setDiagnosticsOptions(diagnosticsOff);
  languages.typescript?.javascriptDefaults?.setDiagnosticsOptions(diagnosticsOff);
}

export function EditorState({
  icon,
  title,
  description,
  tone = "neutral",
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  tone?: "neutral" | "danger";
  action?: ReactNode;
}) {
  return (
    <div className="codespace-workbench-editor grid h-full place-items-center p-5 text-center">
      <div className="codespace-workbench-state">
        <div className={tone === "danger" ? "codespace-workbench-state-icon-danger" : "codespace-workbench-state-icon"}>
          {icon}
        </div>
        <p className="text-xs font-semibold text-[color:var(--codespace-panel-text)]">{title}</p>
        <p className="mt-1 max-w-[34ch] text-[11px] leading-5 text-[color:var(--codespace-panel-text-muted)]">
          {description}
        </p>
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

export function WorkbenchEditor({
  filePath,
  rootDir,
  content,
  loading,
  binary,
  tooLarge = null,
  error,
  dirty,
  onChange,
  onSave,
  onEditorReady,
  revealRange = null,
  contentPath = null,
  wordWrap = false,
  fontSize = DEFAULT_EDITOR_FONT_SIZE,
  onStatusChange,
  onSelectionAction,
  onBlur,
  lsp = null,
  onOpenLocation,
  minimap = false,
  stickyScroll = true,
  editorConfig = null,
  gitBaseline = null,
  blame = null,
}: WorkbenchEditorProps) {
  const { theme } = useTheme();
  const shortcut = useFormatShortcut();
  const monaco = useMonaco();
  const [{ editorDarkTheme, editorLightTheme }] = useEditorPreferences();
  const editorThemeOverrides = useMemo(() => ({ editorDarkTheme, editorLightTheme }), [editorDarkTheme, editorLightTheme]);
  const language = resolveEditorLanguage(filePath);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  // State as well as the ref: the selection popover subscribes to the instance it is given.
  const [mountedEditor, setMountedEditor] = useState<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onSelectionActionRef = useRef(onSelectionAction);
  useEffect(() => {
    onSelectionActionRef.current = onSelectionAction;
  }, [onSelectionAction]);
  const onBlurRef = useRef(onBlur);
  useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);
  const popover = useSelectionPopover(onSelectionAction ? mountedEditor : null, containerRef);

  // The shown model joins its language server; a model this editor switches to joins too.
  const lspPlace = lsp?.place ?? null;
  const lspEnabled = lsp?.enabled ?? false;
  const lspTrusted = lsp?.trusted ?? false;
  const lspPlaceKey = lspPlace ? `${JSON.stringify(lspPlace.location)}|${lspPlace.rootDir}` : null;
  useEffect(() => {
    if (!monaco || !mountedEditor || !lspPlace) return;
    const attach = () => {
      const model = mountedEditor.getModel();
      if (model) void attachLspModel(monaco, model, lspPlace, { enabled: lspEnabled, trusted: lspTrusted });
    };
    attach();
    const subscription = mountedEditor.onDidChangeModel?.(attach);
    return () => subscription?.dispose();
    // The place is named by its key; the object is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco, mountedEditor, lspPlaceKey, lspEnabled, lspTrusted]);

  const onOpenLocationRef = useRef(onOpenLocation);
  useEffect(() => {
    onOpenLocationRef.current = onOpenLocation;
  }, [onOpenLocation]);
  useEffect(() => {
    if (!mountedEditor) return;
    return setLspEditorOpener(mountedEditor, (path, range) => onOpenLocationRef.current?.(path, range));
  }, [mountedEditor]);

  // `.editorconfig` indentation, over Monaco's guess from the file's own lines.
  const configForShown = editorConfig && editorConfig.path === filePath ? editorConfig.config : null;
  useEffect(() => {
    const model = mountedEditor?.getModel();
    if (!model || !configForShown) return;
    const options: MonacoEditorNS.ITextModelUpdateOptions = {};
    if (configForShown.indentStyle) options.insertSpaces = configForShown.indentStyle === "space";
    if (configForShown.tabWidth) options.tabSize = configForShown.tabWidth;
    if (configForShown.indentSize) options.indentSize = configForShown.indentSize;
    if (Object.keys(options).length > 0) model.updateOptions(options);
  }, [configForShown, mountedEditor]);

  // Git marks: green bar added, blue bar changed, red wedge removed.
  const baselineForShown = gitBaseline && gitBaseline.path === filePath ? gitBaseline.text : null;
  useEffect(() => {
    if (!mountedEditor || baselineForShown === null) return;
    const decorations = mountedEditor.createDecorationsCollection?.();
    if (!decorations) return;
    let timer = 0;
    const paint = () => {
      const model = mountedEditor.getModel();
      if (!model) return;
      decorations.set(computeLineChanges(baselineForShown, model.getValue()).map((change) => ({
        range: {
          startLineNumber: Math.max(1, change.startLine),
          startColumn: 1,
          endLineNumber: Math.max(1, change.endLine),
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `codespace-git-gutter codespace-git-gutter-${change.kind}${change.kind === "deleted" && change.startLine === 0 ? " codespace-git-gutter-deleted-top" : ""}`,
        },
      })));
    };
    paint();
    const content = mountedEditor.onDidChangeModelContent?.(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(paint, GIT_GUTTER_DELAY_MS);
    });
    const model = mountedEditor.onDidChangeModel?.(paint);
    return () => {
      window.clearTimeout(timer);
      content?.dispose();
      model?.dispose();
      decorations.clear();
    };
  }, [baselineForShown, mountedEditor]);

  // Inline blame: the cursor line, once the cursor rests; cleared at once when it moves.
  const blameForShown = blame && blame.path === filePath && !dirty ? blame.entries : null;
  useEffect(() => {
    if (!mountedEditor || !blameForShown) return;
    const decorations = mountedEditor.createDecorationsCollection?.();
    if (!decorations) return;
    let timer = 0;
    const paint = () => {
      const line = mountedEditor.getPosition()?.lineNumber;
      const model = mountedEditor.getModel();
      const entry = line && model ? blameAt(blameForShown, line) : null;
      if (!line || !model || !entry) return decorations.clear();
      const end = model.getLineMaxColumn(line);
      const hover = blameHover(entry, Date.now());
      decorations.set([{
        range: { startLineNumber: line, startColumn: end, endLineNumber: line, endColumn: end },
        options: {
          // An empty range at the line's end draws nothing without this (measured on Monaco 0.55).
          showIfCollapsed: true,
          after: { content: blameInline(entry, Date.now()), inlineClassName: "codespace-inline-blame", cursorStops: 0 },
          ...(hover ? { hoverMessage: { value: hover } } : {}),
        },
      }]);
    };
    const rest = () => {
      decorations.clear();
      window.clearTimeout(timer);
      timer = window.setTimeout(paint, BLAME_DELAY_MS);
    };
    rest();
    const cursor = mountedEditor.onDidChangeCursorPosition?.(rest);
    const model = mountedEditor.onDidChangeModel?.(rest);
    return () => {
      window.clearTimeout(timer);
      cursor?.dispose();
      model?.dispose();
      decorations.clear();
    };
  }, [blameForShown, mountedEditor]);

  // Track the last *successfully loaded* theme name. We only commit to a new
  // theme name after the async Shiki load completes — passing an unloaded name
  // to <MonacoEditor theme={...}> throws a ShikiError immediately.
  const [activeMonacoTheme, setActiveMonacoTheme] = useState<string>(() =>
    getCodespaceMonacoThemeName(theme)
  );

  const handleBeforeMount = useCallback((monacoApi: MonacoApi) => {
    silenceMonacoTypeScriptDiagnostics(monacoApi);
    const target = getCodespaceMonacoThemeName(theme, editorThemeOverrides);
    void applyCodespaceMonacoTheme(monacoApi, theme, editorThemeOverrides).then(() => {
      setActiveMonacoTheme(target);
    });
  }, [theme, editorThemeOverrides]);

  useEffect(() => {
    if (!monaco) return;
    silenceMonacoTypeScriptDiagnostics(monaco);
    const target = getCodespaceMonacoThemeName(theme, editorThemeOverrides);
    void applyCodespaceMonacoTheme(monaco, theme, editorThemeOverrides).then(() => {
      setActiveMonacoTheme(target);
    });
  }, [monaco, theme, editorThemeOverrides]);

  // A file no pane holds any more gives its model back.
  useEffect(() => {
    if (monaco) installEditorModelReaper(monaco);
  }, [monaco]);
  // The model left behind — another file shown, or Monaco hidden — is freed if no tab holds it
  // now: its release came while it was still on screen (attached), so it was kept then. Monaco
  // keeps the model of an open tab when it hides (`keepCurrentModel`), with its undo history, and
  // the cursor and scroll it had; the timeout lets Monaco let go of it first.
  const monacoShown = Boolean(filePath) && !loading && !binary && !error;
  useEffect(() => {
    if (!monaco || !monacoShown || !filePath) return;
    const shown = filePath;
    return () => {
      setTimeout(() => disposeDetachedEditorModel(monaco, shown), 0);
    };
  }, [filePath, monaco, monacoShown]);

  // One listener for the editor's life. An inline arrow is a new function every render, and
  // `@monaco-editor/react` drops and re-adds its content listener whenever `onChange` changes.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const handleChange = useCallback((value: string | undefined) => onChangeRef.current(value ?? ""), []);

  // Rare languages load their grammar the first time a file needs one.
  useEffect(() => {
    if (monaco) void ensureCodespaceLanguage(monaco, language);
  }, [language, monaco]);

  const onEditorReadyRef = useRef(onEditorReady);
  const onStatusChangeRef = useRef(onStatusChange);
  const stopStatusRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);
  const rootDirRef = useRef(rootDir);
  const filePathRef = useRef(filePath);
  const revealRangeRef = useRef(revealRange);
  const syncRef = useRef({ content, contentPath, filePath });
  const revealedNonceRef = useRef<number | null>(null);

  useEffect(() => {
    onEditorReadyRef.current = onEditorReady;
  }, [onEditorReady]);

  useEffect(() => {
    rootDirRef.current = rootDir;
  }, [rootDir]);

  useEffect(() => {
    filePathRef.current = filePath;
  }, [filePath]);

  // Monaco unmounts while a file loads or cannot be shown; a reveal must not reach the old instance.
  const monacoMounted = Boolean(filePath) && !loading && !binary && !error;
  useEffect(() => {
    if (monacoMounted) return;
    editorRef.current = null;
    setMountedEditor(null);
    stopStatusRef.current?.();
    stopStatusRef.current = null;
    onStatusChangeRef.current?.(null);
  }, [monacoMounted]);
  useEffect(() => () => stopStatusRef.current?.(), []);

  useEffect(() => {
    syncRef.current = { content, contentPath, filePath };
    const editorInstance = editorRef.current;
    if (editorInstance && contentPath && contentPath === filePath) applyExternalContent(editorInstance, content);
  }, [content, contentPath, filePath]);

  const revealNonce = revealRange?.nonce ?? null;
  useEffect(() => {
    revealRangeRef.current = revealRange;
    const editorInstance = editorRef.current;
    if (!editorInstance || !revealRange || revealedNonceRef.current === revealRange.nonce) return;
    if (revealLines(editorInstance, revealRange)) revealedNonceRef.current = revealRange.nonce;
    // The nonce names the request; the range object itself is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce, filePath]);

  const handleMount = useCallback((editorInstance: MonacoEditorNS.IStandaloneCodeEditor, monacoApi: MonacoApi) => {
    editorRef.current = editorInstance;
    setMountedEditor(editorInstance);
    editorInstance.focus();
    // Optional: the tests' stand-in editors do not have it.
    editorInstance.onDidBlurEditorWidget?.(() => onBlurRef.current?.());
    stopStatusRef.current?.();
    stopStatusRef.current = onStatusChangeRef.current
      ? watchEditorStatus(editorInstance, (status) => onStatusChangeRef.current?.(status))
      : null;
    editorInstance.addAction({
      id: "lotus.copyRelativePath",
      label: "Copy Relative Path",
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 1.5,
      run: () => {
        const fp = filePathRef.current;
        const rd = rootDirRef.current;
        if (!fp) return;
        const relative = rd ? path.relative(rd, fp) : fp;
        void copyTextToClipboard(relative).catch(() => {});
      },
    });
    editorInstance.addAction({
      id: "lotus.copyAbsolutePath",
      label: "Copy Absolute Path",
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 1.6,
      run: () => {
        const fp = filePathRef.current;
        if (!fp) return;
        void copyTextToClipboard(fp).catch(() => {});
      },
    });
    // Registered whether or not a handler is there yet; `run` reads the current one. ⌘L replaces
    // Monaco's own "expand line selection", as in VS Code-style editors with a chat.
    const runSelectionAction = (action: SelectionAction) => {
      const handler = onSelectionActionRef.current;
      const selection = readLineSelection(editorInstance);
      if (handler && selection) handler(action, selection);
    };
    editorInstance.addAction({
      id: "lotus.sendSelectionToThread",
      label: "Send to Thread",
      keybindings: sendSelectionKeybinding(monacoApi),
      contextMenuGroupId: "0_lotus",
      contextMenuOrder: 1,
      run: () => runSelectionAction("send"),
    });
    editorInstance.addAction({
      id: "lotus.askAboutSelection",
      label: "Ask About This",
      contextMenuGroupId: "0_lotus",
      contextMenuOrder: 2,
      precondition: "editorHasSelection",
      run: () => runSelectionAction("ask"),
    });
    const sync = syncRef.current;
    if (sync.contentPath && sync.contentPath === sync.filePath) applyExternalContent(editorInstance, sync.content);
    const pendingReveal = revealRangeRef.current;
    if (pendingReveal && revealedNonceRef.current !== pendingReveal.nonce && revealLines(editorInstance, pendingReveal)) {
      revealedNonceRef.current = pendingReveal.nonce;
    }
    onEditorReadyRef.current?.({
      focus: () => editorInstance.focus(),
      undo: () => editorInstance.trigger("keyboard", "undo", null),
      redo: () => editorInstance.trigger("keyboard", "redo", null),
      setValue: (newContent: string) => applyExternalContent(editorInstance, newContent),
      showNextProblem: () => {
        editorInstance.focus();
        editorInstance.trigger("keyboard", "editor.action.marker.next", null);
      },
      setEndOfLine: (eol: "LF" | "CRLF") => {
        const model = editorInstance.getModel();
        if (!model) return;
        // 0 = LF, 1 = CRLF (EndOfLineSequence). Pushed, so ⌘Z takes it back.
        model.pushEOL(eol === "CRLF" ? 1 : 0);
      },
      prepareSave: (steps) => prepareSave(editorInstance, steps, filePathRef),
    });
  }, []);

  if (!filePath) {
    return (
      <EditorState
        icon={<FileCode2 className="h-4 w-4" />}
        title="Open a file"
        description={`Pick one in the file tree, or press ${shortcut("⌘P")} to go to any file.`}
      />
    );
  }

  if (loading) {
    return (
      <EditorState
        icon={<Loader2 className="h-4 w-4 animate-spin" />}
        title="Reading file"
        description="Loading the latest contents from disk."
      />
    );
  }

  if (error) {
    return (
      <EditorState
        icon={<AlertTriangle className="h-4 w-4" />}
        title="Unable to open file"
        description={error}
        tone="danger"
      />
    );
  }

  if (binary && tooLarge) {
    const size = formatByteSize(tooLarge.sizeBytes);
    return (
      <EditorState
        icon={<FileCode2 className="h-4 w-4" />}
        title={`Large file (${size})`}
        description={tooLarge.onOpenAnyway
          ? "Files over 10 MB are not opened by default. It can be slow to edit."
          : "Files over 50 MB are too large for the editor."}
        action={tooLarge.onOpenAnyway ? (
          <button type="button" className="codespace-workbench-state-action" onClick={tooLarge.onOpenAnyway}>
            Open anyway
          </button>
        ) : null}
      />
    );
  }

  if (binary) {
    return (
      <EditorState
        icon={<FileCode2 className="h-4 w-4" />}
        title="Binary file"
        description="This file is not text, or uses a text encoding the editor cannot read safely (such as Shift-JIS)."
      />
    );
  }

  return (
    <div ref={containerRef} className="codespace-workbench-editor relative min-h-0 flex-1 overflow-hidden">
      <MonacoEditor
        path={filePath}
        keepCurrentModel
        language={language}
        defaultValue={content}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        onChange={handleChange}
        theme={activeMonacoTheme}
        options={{
          minimap: { enabled: minimap, renderCharacters: false, maxColumn: 80 },
          stickyScroll: { enabled: stickyScroll },
          fontSize,
          lineHeight: editorLineHeight(fontSize),
          fontFamily: detectMonoFontFamily(),
          fontLigatures: true,
          smoothScrolling: true,
          scrollBeyondLastLine: false,
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          lineNumbersMinChars: 3,
          glyphMargin: false,
          // Room for the git marks beside the line numbers.
          lineDecorationsWidth: 8,
          folding: true,
          showFoldingControls: "mouseover",
          scrollbar: {
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
          },
          automaticLayout: true,
          wordWrap: wordWrap ? "on" : "off",
          renderLineHighlight: "line",
          bracketPairColorization: { enabled: true },
          guides: { indentation: true, bracketPairs: "active" },
          renderWhitespace: "selection",
          padding: {
            top: 10,
            bottom: 16,
          },
        }}
      />
      {popover.position && mountedEditor && onSelectionAction ? (
        <SelectionPopover
          position={popover.position}
          lineLabel={popoverLineLabel(mountedEditor, filePath, rootDir)}
          onAction={(action) => {
            const selection = readLineSelection(mountedEditor);
            popover.hide();
            if (selection) onSelectionAction(action, selection);
          }}
        />
      ) : null}
      {dirty && (
        <button
          type="button"
          onClick={onSave}
          className="codespace-workbench-save-button"
          title="Save changes"
        >
          <Save className="h-3 w-3" aria-hidden="true" />
          Save changes
        </button>
      )}
    </div>
  );
}
