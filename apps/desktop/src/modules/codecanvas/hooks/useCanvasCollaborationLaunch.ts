"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { resolveCanvasCollaborationLaunch, type CanvasCollaborationLaunch } from "../services/canvas-collaboration-launch";

/** URL adapter for the optional CodeCanvas collaboration overlay. */
export function useCanvasCollaborationLaunch(): CanvasCollaborationLaunch {
  const searchParams = useSearchParams();
  return useMemo(() => resolveCanvasCollaborationLaunch(searchParams), [searchParams]);
}
