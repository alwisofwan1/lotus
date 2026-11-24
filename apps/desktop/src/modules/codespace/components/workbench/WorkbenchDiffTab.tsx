"use client";

import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import type { CodespaceGitDiffTarget, CodespaceGitFileDiffContent } from "@/lib/tauri-api";
import type { DiffTabTarget } from "@/modules/codespace/components/types";
import { cn } from "@/lib/utils";
import { resolveDiffLayout, type DiffLayout } from "@/modules/codespace/services/diff-layout";
import { countDiffLines } from "@/modules/codespace/services/git-diff-stats";
import { WorkbenchDiffPreview, type WorkbenchDiffPreviewProps } from "./WorkbenchDiffPreview";

const SIDE_LABELS: Record<DiffTabTarget, string> = {
  unstaged: "Working tree",
  staged: "Staged",
  disk: "Disk ↔ your edits",
};

const EMPTY_LABELS: Record<DiffTabTarget, string> = {
  unstaged: "No changes in working tree for this file.",
  staged: "No changes in staged for this file.",
  disk: "Your edits match the file on disk.",
};

export interface WorkbenchDiffTabProps {
  filePath: string;
  /** Shown in the header, relative to the pane's folder. */
  displayPath: string;
  target: DiffTabTarget;
  /** The git sides with changes. With both, the header switches between them. */
  sides: readonly CodespaceGitDiffTarget[];
  onTargetChange: (target: CodespaceGitDiffTarget) => void;
  /** The pane's own pick, or null to follow its width. */
  manualLayout: DiffLayout | null;
  onLayoutChange: (layout: DiffLayout) => void;
  onOpenFile: () => void;
  content: string;
  fileContent: CodespaceGitFileDiffContent;
  loading: boolean;
  error: string | null;
  fontSize: number;
  /** ⌘L / the popover in the diff: the selection, with what is needed to cut a patch. */
  onSelectionAction?: WorkbenchDiffPreviewProps["onSelectionAction"];
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="codespace-diff-segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn("codespace-diff-segment", option.value === value && "codespace-diff-segment-active")}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A diff as a tab: header (path, +N −M, side, layout, Open file) over the diff editor. */
export function WorkbenchDiffTab({
  filePath,
  displayPath,
  target,
  sides,
  onTargetChange,
  manualLayout,
  onLayoutChange,
  onOpenFile,
  content,
  fileContent,
  loading,
  error,
  fontSize,
  onSelectionAction,
}: WorkbenchDiffTabProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);

  // The tab's own width, so a narrow pane beside a wide one gets its own layout.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width;
      if (width) setPaneWidth(width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const layout = resolveDiffLayout(paneWidth, manualLayout);
  // No unified text for a disk compare (Monaco diffs the two texts itself), so no count.
  const stats = loading || error || target === "disk" ? null : countDiffLines(content);

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div role="toolbar" aria-label="Diff" className="codespace-diff-header">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="codespace-diff-icon">
            <FileText className="h-3 w-3" aria-hidden="true" />
          </span>
          <p className="min-w-0 truncate text-[11px] font-medium text-[color:var(--codespace-panel-text)]" title={filePath}>
            {displayPath}
          </p>
          {stats ? (
            <span className="codespace-diff-stats" aria-label={`${stats.additions} added, ${stats.deletions} removed`}>
              <span className="text-emerald-200/80">+{stats.additions}</span>
              <span className="text-red-200/78">−{stats.deletions}</span>
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {sides.length > 1 && target !== "disk" ? (
            <Segmented
              label="Side"
              options={sides.map((side) => ({ value: side, label: SIDE_LABELS[side] }))}
              value={target}
              onChange={onTargetChange}
            />
          ) : (
            <span className="codespace-diff-side-label">{SIDE_LABELS[target]}</span>
          )}
          <Segmented
            label="Layout"
            options={[{ value: "split", label: "Split" }, { value: "inline", label: "Inline" }]}
            value={layout}
            onChange={onLayoutChange}
          />
          <button type="button" className="codespace-diff-action" onClick={onOpenFile} title={`Open ${displayPath}`}>
            Open file
          </button>
        </div>
      </div>
      <WorkbenchDiffPreview
        content={content}
        originalContent={fileContent.original}
        modifiedContent={fileContent.modified}
        originalPath={fileContent.originalPath}
        modifiedPath={fileContent.modifiedPath}
        filePath={filePath}
        renderSideBySide={layout === "split"}
        loading={loading}
        error={error}
        emptyLabel={EMPTY_LABELS[target]}
        fontSize={fontSize}
        displayPath={displayPath}
        onSelectionAction={onSelectionAction}
      />
    </div>
  );
}
