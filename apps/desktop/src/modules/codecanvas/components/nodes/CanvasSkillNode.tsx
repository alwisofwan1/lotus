"use client";
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { X, FileText } from "lucide-react";
import { WorkbenchMarkdownPreview } from "@/modules/codespace/components/workbench/WorkbenchMarkdownPreview";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import type { CanvasSkillNodeData } from "../../types/canvas";

export const CanvasSkillNode = memo(function CanvasSkillNode({ id, data, selected }: NodeProps) {
  const { skillName, source, content, description, metadata, dispatchCommand, onClose } = data as CanvasSkillNodeData;

  return (
    <CanvasNodeFrame
      kind="skill"
      selected={!!selected}
      minWidth={280}
      minHeight={200}
      header={
        <div className="canvas-node-header canvas-skill-node-header">
          <span className="canvas-node-header-label">
            <span className="canvas-node-chip" aria-hidden>
              <FileText />
            </span>
            <span className="canvas-skill-node-name">/{skillName}</span>
            <span className={`canvas-skill-badge canvas-skill-badge--${source}`}>
              {source === "project" ? "PROJECT" : "GLOBAL"}
            </span>
          </span>
          <div className="canvas-node-actions">
            {dispatchCommand && (
              <CanvasNodeFocusAction
                onFocus={() => dispatchCommand({ kind: "focus-node", nodeId: id })}
                className="canvas-node-close canvas-node-focus"
              />
            )}
            <button
              className="canvas-node-close"
              aria-label={`Close /${skillName}`}
              onClick={() => {
                if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
                else onClose?.(id);
              }}
            >
              <X size={11} aria-hidden />
            </button>
          </div>
        </div>
      }
    >
      <div className="canvas-node-body canvas-skill-node-body nodrag nowheel">
        <WorkbenchMarkdownPreview
          content={content}
          className="wbmd-skill-preview"
          metadata={buildSkillMetadata(skillName, description, metadata)}
          preserveSoftBreaks
        />
      </div>
    </CanvasNodeFrame>
  );
});

function buildSkillMetadata(
  skillName: string,
  description?: string,
  metadata?: Array<{ key: string; value: string }>,
) {
  if (metadata && metadata.length > 0) return metadata;

  return [
    { key: "name", value: skillName },
    ...(description ? [{ key: "description", value: description }] : []),
  ];
}
