"use client";
import { useSyncExternalStore } from "react";
import {
  getCanvasViewportMotionSnapshot,
  subscribeCanvasViewportMotion,
  type CanvasViewportMotionSnapshot,
} from "../services/viewport/canvas-viewport-motion";

const SERVER_SNAPSHOT: CanvasViewportMotionSnapshot = { active: false, frozenLodTier: null, version: 0 };

export function useCanvasViewportMotionSnapshot(): CanvasViewportMotionSnapshot {
  return useSyncExternalStore(subscribeCanvasViewportMotion, getCanvasViewportMotionSnapshot, () => SERVER_SNAPSHOT);
}
