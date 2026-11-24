"use client";
import { useEffect, useMemo, useState } from "react";
import type { AppTheme } from "@/lib/design-system";
import { useEditorPreferences } from "@/modules/codespace/hooks/useEditorPreferences";
import { resolveEditorLanguage } from "@/modules/codespace/services/editor-languages";
import { getCodespaceMonacoThemeName, highlightCodespaceLines, type HighlightedToken } from "@/modules/codespace/services/monaco-theme";
import { activeFileSource, fetchGitBaseline, fileWatchRegistry } from "../services/file-node/file-node-io";
import { MAX_HIGHLIGHT_LINES } from "../services/file-node/file-node-view";
import type { FileView } from "../services/file-node/file-watch-registry";
import { useCanvasTheme } from "./useCanvasTheme";

/**
 * A File Node's file: its live state from the shared registry, and git's copy for the marks.
 *
 * `active` is false below the glyph tier: the node unsubscribes, so a zoomed-out board with many
 * File Nodes holds no reads and (once the last one lets go) no watch. The last view is kept, so
 * zooming back in shows the file at once and refreshes it.
 */
export function useFileNodeView(path: string, active: boolean): { view: FileView; baseline: string | null } {
  const [view, setView] = useState<FileView>({ status: "loading" });
  const [baseline, setBaseline] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const source = activeFileSource(path);
    if (!source) {
      setView({ status: "error", message: "No project is open." });
      return;
    }
    return fileWatchRegistry.subscribe(source, setView);
  }, [path, active]);

  // A fresh read can mean git moved too (commit, stage), so the baseline follows `rev`.
  const rev = view.status === "ready" ? view.rev : null;
  useEffect(() => {
    if (!active || rev === null) return;
    const source = activeFileSource(path);
    if (!source) return;
    let cancelled = false;
    void fetchGitBaseline(source).then((text) => {
      if (!cancelled) setBaseline(text);
    });
    return () => {
      cancelled = true;
    };
  }, [path, active, rev]);

  return { view, baseline };
}

/**
 * Coloured runs for the file's text, in the editor's theme for the canvas's light or dark. Null until
 * ready, and null again while the text has moved on from what they were made for: the runs replace
 * the line text when drawn, so tokens of the old content would show code that is no longer there.
 */
export function useFileNodeHighlight(content: string | null, path: string): HighlightedToken[][] | null {
  const { theme } = useCanvasTheme();
  const [{ editorDarkTheme, editorLightTheme }] = useEditorPreferences();
  const themeName = useMemo(
    () => getCodespaceMonacoThemeName({ type: theme.mode } as AppTheme, { editorDarkTheme, editorLightTheme }),
    [theme.mode, editorDarkTheme, editorLightTheme],
  );
  const [made, setMade] = useState<{ content: string; path: string; themeName: string; tokens: HighlightedToken[][] } | null>(null);

  useEffect(() => {
    if (content === null) return;
    let cancelled = false;
    const head = content.split(/\r\n|\r|\n/, MAX_HIGHLIGHT_LINES).join("\n");
    highlightCodespaceLines(head, resolveEditorLanguage(path), themeName).then(
      (lines) => { if (!cancelled) setMade({ content, path, themeName, tokens: lines }); },
      () => { if (!cancelled) setMade(null); },
    );
    return () => {
      cancelled = true;
    };
  }, [content, path, themeName]);

  // Same content and path is enough to draw; a theme change keeps the old colours until the new ones land.
  return made && made.content === content && made.path === path ? made.tokens : null;
}
