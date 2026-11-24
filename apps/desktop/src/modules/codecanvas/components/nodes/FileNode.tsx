"use client";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { NodeProps } from "@xyflow/react";
import { AlertTriangle, FileCode2, FileQuestion, Loader2, Pencil, Scan, X } from "lucide-react";
import { editorLanguageLabel, resolveEditorLanguage } from "@/modules/codespace/services/editor-languages";
import { formatByteSize } from "@/modules/codespace/services/editor-media";
import { computeLineChanges } from "@/modules/codespace/services/editor-line-diff";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeGlyph } from "./CanvasNodeGlyph";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { useFileAgentChip } from "../../hooks/useFileAgentChip";
import { useFileNodeHighlight, useFileNodeView } from "../../hooks/useFileNode";
import { getActiveProjectRootDir } from "../../services/canvas-active-project";
import { fileNodeNames, gutterMarksByLine, lineWindow } from "../../services/file-node/file-node-view";
import { openInCode } from "../../services/open-in-code";
import type { CanvasFileNodeData } from "../../types/canvas";

/** Fixed, so the body can draw only the lines in view; keep in step with `--file-line-h` in file-node.css. */
const LINE_HEIGHT = 19;
const OVERSCAN = 12;
/** Before the body has been measured (and under jsdom, which never measures). */
const FALLBACK_VIEWPORT_HEIGHT = 420;
const SCROLL_SAVE_DELAY_MS = 400;

/**
 * A File Node: one project file, read-only and live, on the board (plans/canvas-code, S3).
 *
 * It only LOOKS at the file. Editing is the Code app in the Canvas Dock (Edit button, or ⏎ while
 * the node is selected), because Monaco does not survive the board's CSS-transform zoom (S0). The
 * body scrolls itself (`nodrag nopan nowheel`); the header drags the node. Below the glyph tier it
 * stops reading and watching.
 */
export const FileNode = memo(function FileNode({ id, data, selected }: NodeProps) {
  const { path, viewport, dispatchCommand } = data as CanvasFileNodeData;
  const lodTier = useCanvasLodTier();
  const full = lodTier === "full";
  const { view, baseline } = useFileNodeView(path, full);
  const text = view.status === "ready" ? view.content : null;
  const tokens = useFileNodeHighlight(text, path);
  const agentChip = useFileAgentChip(path, baseline, text);
  const root = getActiveProjectRootDir() ?? "";
  const { name, dir } = fileNodeNames(path, root);
  const languageLabel = editorLanguageLabel(resolveEditorLanguage(path));

  const edit = useCallback(() => openInCode({ path }), [path]);

  // ⏎ on the selected node is the canvas hotkey layer's (`dive-into-node` in CanvasPage), not ours.

  const close = useCallback(() => dispatchCommand?.({ kind: "close-node", nodeId: id }), [dispatchCommand, id]);
  const focus = dispatchCommand ? () => dispatchCommand({ kind: "focus-node", nodeId: id }) : undefined;

  const header = (
    <div className="canvas-node-header canvas-file-header">
      <div className="canvas-file-id" title={path}>
        <FileCode2 className="canvas-file-icon" size={14} aria-hidden />
        <span className="canvas-file-name">{name}</span>
        {dir ? <span className="canvas-file-dir">{dir}</span> : null}
      </div>
      <div className="canvas-file-actions nodrag">
        {agentChip ? (
          <span className="canvas-file-chip" data-testid="file-node-agent-chip" title={`${agentChip.name} is editing this file`}>
            <span className="canvas-file-chip-name">{agentChip.name}</span>
            <span className="canvas-file-chip-add">+{agentChip.added}</span>
            <span className="canvas-file-chip-del">−{agentChip.removed}</span>
          </span>
        ) : null}
        {view.status !== "missing" ? (
          <button type="button" className="canvas-file-edit" aria-label={`Edit ${name} in Code`} title="Open in Code (⏎)" onClick={edit}>
            <Pencil size={11} aria-hidden />
            <span>Edit</span>
            <kbd aria-hidden>⏎</kbd>
          </button>
        ) : null}
        {focus ? (
          <button type="button" className="canvas-node-close" aria-label="Focus file node" title="Focus" onClick={focus}>
            <Scan size={11} aria-hidden />
          </button>
        ) : null}
        {dispatchCommand ? (
          <button type="button" className="canvas-node-close" aria-label="Close file node" title="Close" onClick={close}>
            <X size={12} aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <CanvasNodeFrame
      kind="file"
      selected={!!selected}
      minWidth={320}
      minHeight={200}
      header={header}
      lodTier={lodTier}
      statusTone={view.status === "missing" || view.status === "error" ? "error" : "idle"}
      glyph={<CanvasNodeGlyph label={name} tone={view.status === "missing" || view.status === "error" ? "error" : "neutral"} detail="File" />}
    >
      <div className="canvas-file-body nodrag nopan nowheel" data-testid="canvas-file-body" onPointerDown={(e) => e.stopPropagation()}>
        <FileBody
          view={view}
          path={path}
          baseline={baseline}
          tokens={tokens}
          topLine={viewport?.topLine ?? 0}
          onScrollSettled={dispatchCommand ? (topLine) => dispatchCommand({ kind: "patch-file", nodeId: id, patch: { viewport: { topLine } } }) : undefined}
          onOpenInCode={edit}
        />
      </div>
      <div className="canvas-file-footer">
        <span>{languageLabel}</span>
        <span className="canvas-file-footer-note">Read-only on the board</span>
      </div>
    </CanvasNodeFrame>
  );
});

function State({ icon, title, description, tone, action }: { icon: ReactNode; title: string; description?: string; tone?: "danger"; action?: ReactNode }) {
  return (
    <div className="canvas-file-state" data-tone={tone} role="status">
      {icon}
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {action}
    </div>
  );
}

interface FileBodyProps {
  view: ReturnType<typeof useFileNodeView>["view"];
  path: string;
  baseline: string | null;
  tokens: ReturnType<typeof useFileNodeHighlight>;
  topLine: number;
  onScrollSettled?: (topLine: number) => void;
  onOpenInCode: () => void;
}

function FileBody({ view, path, baseline, tokens, topLine, onScrollSettled, onOpenInCode }: FileBodyProps) {
  switch (view.status) {
    case "loading":
      return <State icon={<Loader2 size={16} className="canvas-file-spin" aria-hidden />} title="Reading file" />;
    case "missing":
      return <State icon={<FileQuestion size={16} aria-hidden />} tone="danger" title="File not found" description="This file was deleted or moved. Remove the node, or restore the file and it will reappear." />;
    case "error":
      return <State icon={<AlertTriangle size={16} aria-hidden />} tone="danger" title="Unable to read file" description={view.message} />;
    case "too-large":
      return (
        <State
          icon={<FileCode2 size={16} aria-hidden />}
          title={`Large file (${formatByteSize(view.sizeBytes)})`}
          description="Too large to show on the board."
          action={<button type="button" className="canvas-file-state-action" onClick={onOpenInCode}>Open in Code</button>}
        />
      );
    case "binary":
      return (
        <State
          icon={<FileCode2 size={16} aria-hidden />}
          title="Binary file"
          description="Not text, so there is nothing to show here."
          action={<button type="button" className="canvas-file-state-action" onClick={onOpenInCode}>Open in Code</button>}
        />
      );
    case "ready":
      return <CodeLines key={path} content={view.content} baseline={baseline} tokens={tokens} topLine={topLine} onScrollSettled={onScrollSettled} />;
  }
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function CodeLines({ content, baseline, tokens, topLine, onScrollSettled }: { content: string; baseline: string | null; tokens: FileBodyProps["tokens"]; topLine: number; onScrollSettled?: (topLine: number) => void }) {
  const lines = useMemo(() => splitLines(content), [content]);
  const marks = useMemo(() => (baseline === null ? new Map() : gutterMarksByLine(computeLineChanges(baseline, content))), [baseline, content]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(topLine * LINE_HEIGHT);
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_HEIGHT);
  const lastSaved = useRef(topLine);
  const saveTimer = useRef<number | undefined>(undefined);
  const gutterWidth = `${String(lines.length).length + 1}ch`;

  // Come back to where the board was left, once.
  useLayoutEffect(() => {
    if (scroller.current && topLine > 0) scroller.current.scrollTop = topLine * LINE_HEIGHT;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (!onScrollSettled) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const next = Math.floor(el.scrollTop / LINE_HEIGHT);
      if (next === lastSaved.current) return;
      lastSaved.current = next;
      onScrollSettled(next);
    }, SCROLL_SAVE_DELAY_MS);
  }, [onScrollSettled]);

  const { start, end } = lineWindow({ scrollTop, viewportHeight, lineHeight: LINE_HEIGHT, total: lines.length, overscan: OVERSCAN });

  return (
    <div ref={scroller} className="canvas-file-scroll" onScroll={onScroll} tabIndex={0} role="region" aria-label="File contents, read-only">
      <div className="canvas-file-lines" style={{ height: lines.length * LINE_HEIGHT, ["--file-gutter" as string]: gutterWidth }}>
        <div className="canvas-file-window" style={{ transform: `translateY(${start * LINE_HEIGHT}px)` }}>
          {lines.slice(start, end).map((line, offset) => {
            const index = start + offset;
            const lineNumber = index + 1;
            const runs = tokens?.[index];
            return (
              <div key={lineNumber} className="canvas-file-line" data-line={lineNumber} data-mark={marks.get(lineNumber)}>
                <span className="canvas-file-gutter" aria-hidden>
                  <span className="canvas-file-mark" />
                  <span className="canvas-file-lineno">{lineNumber}</span>
                </span>
                <code className="canvas-file-code">
                  {runs && runs.length > 0
                    ? runs.map((run, i) => <span key={i} style={run.color ? { color: run.color } : undefined}>{run.content}</span>)
                    : line || " "}
                </code>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
