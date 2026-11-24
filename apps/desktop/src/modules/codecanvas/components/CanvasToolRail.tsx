"use client";
import { Fragment, memo, useRef, type ReactNode } from "react";
import {
  MousePointer2, Hand, Square, Diamond, Circle, ArrowUpRight, Minus, Pencil, Type, Eraser, SquareDashed,
} from "lucide-react";
import type { CanvasTool } from "../services/canvas-tool";
import { useDockedOccluder } from "../hooks/useDockedOccluder";

interface ToolDef {
  tool: CanvasTool;
  label: string;
  icon: ReactNode;
  shortcut?: string;
}

// Excalidraw-style toolset (reference). Group 1 = modes; group 2 = drawing tools.
const TOOL_GROUPS: ToolDef[][] = [
  [
    { tool: "select", label: "Select", shortcut: "V", icon: <MousePointer2 size={16} /> },
    { tool: "pan", label: "Pan", shortcut: "H", icon: <Hand size={16} /> },
  ],
  [
    { tool: "frame", label: "Frame", shortcut: "N", icon: <SquareDashed size={16} /> },
    { tool: "rectangle", label: "Rectangle", shortcut: "R", icon: <Square size={16} /> },
    { tool: "diamond", label: "Diamond", shortcut: "D", icon: <Diamond size={16} /> },
    { tool: "ellipse", label: "Ellipse", shortcut: "O", icon: <Circle size={16} /> },
    { tool: "arrow", label: "Arrow", shortcut: "A", icon: <ArrowUpRight size={16} /> },
    { tool: "line", label: "Line", shortcut: "L", icon: <Minus size={16} /> },
    { tool: "draw", label: "Draw", shortcut: "P", icon: <Pencil size={16} /> },
    { tool: "text", label: "Text", shortcut: "T", icon: <Type size={16} /> },
    { tool: "eraser", label: "Eraser", shortcut: "E", icon: <Eraser size={16} /> },
  ],
];

interface CanvasToolRailProps {
  activeTool: CanvasTool;
  onSelectTool: (tool: CanvasTool) => void;
}

/**
 * Left-edge whiteboard tool rail (Excalidraw-style). Presentational: reports the picked
 * tool; creation/keyboard wiring lives in the page. Coexists with the right sidebar.
 */
export const CanvasToolRail = memo(function CanvasToolRail({ activeTool, onSelectTool }: CanvasToolRailProps) {
  const railRef = useRef<HTMLElement>(null);
  // Browser nodes clip their native WebView around this rail so it never covers the tool buttons.
  useDockedOccluder(railRef);
  return (
    <nav ref={railRef} className="canvas-tool-rail" aria-label="Canvas tools">
      {TOOL_GROUPS.map((group, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 ? <span className="canvas-tool-rail-div" /> : null}
          {group.map(({ tool, label, icon, shortcut }) => (
            <button
              key={tool}
              type="button"
              className="canvas-tool-rail-btn"
              aria-pressed={activeTool === tool}
              aria-label={label}
              title={shortcut ? `${label} — ${shortcut}` : label}
              onClick={() => onSelectTool(tool)}
            >
              {icon}
            </button>
          ))}
        </Fragment>
      ))}
    </nav>
  );
});
