"use client";

import type { MouseEventHandler, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface WindowChromeProps {
  className: string;
  contentClassName?: string;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
  onDoubleClick?: MouseEventHandler<HTMLDivElement>;
  dragRegionEnabled: boolean;
  dragRegionCapturesDoubleClick?: boolean;
  overlayDragRegionClassName?: string;
  leftDragRegionClassName?: string;
  centerDragRegionClassName?: string;
  leftContent?: ReactNode;
  rightContent?: ReactNode;
}

export function WindowChrome({
  className,
  contentClassName,
  onMouseDown,
  onDoubleClick,
  dragRegionEnabled,
  dragRegionCapturesDoubleClick = false,
  overlayDragRegionClassName,
  leftDragRegionClassName,
  centerDragRegionClassName,
  leftContent,
  rightContent,
}: WindowChromeProps) {
  return (
    <div
      className={className}
      onMouseDown={onMouseDown}
      onDoubleClick={dragRegionCapturesDoubleClick ? undefined : onDoubleClick}
    >
      {dragRegionEnabled && overlayDragRegionClassName && (
        <div
          data-tauri-drag-region
          onDoubleClick={dragRegionCapturesDoubleClick ? onDoubleClick : undefined}
          className={overlayDragRegionClassName}
          aria-hidden="true"
        />
      )}
      <div className={cn("relative z-10 flex h-full items-stretch", contentClassName)}>
        {leftDragRegionClassName && (
          <div
            data-tauri-drag-region={dragRegionEnabled ? "true" : undefined}
            onDoubleClick={dragRegionCapturesDoubleClick ? onDoubleClick : undefined}
            className={leftDragRegionClassName}
            aria-hidden="true"
          />
        )}
        {leftContent}
        {centerDragRegionClassName && (
          <div
            data-tauri-drag-region={dragRegionEnabled ? "true" : undefined}
            onDoubleClick={dragRegionCapturesDoubleClick ? onDoubleClick : undefined}
            className={centerDragRegionClassName}
            aria-hidden={dragRegionEnabled ? "true" : undefined}
          />
        )}
        {rightContent}
      </div>
    </div>
  );
}
