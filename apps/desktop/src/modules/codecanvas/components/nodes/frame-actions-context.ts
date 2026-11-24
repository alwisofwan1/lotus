"use client";
import { createContext, useContext } from "react";

/**
 * What a Frame's title tab can do. FrameNode is rendered by React Flow from a static node-type
 * map, so the canvas hands these in through context instead of props. The defaults are no-ops so
 * a Frame rendered outside the canvas (a test, a preview) is inert rather than throwing.
 */
export interface FrameActions {
  rename: (frameId: string, title: string) => void;
  recolor: (frameId: string, colorId: string) => void;
  fit: (frameId: string) => void;
  /** Delete the Frame, members stay loose. Undoable. */
  deleteKeepMembers: (frameId: string) => void;
  /** Open the confirm dialog for "Delete with contents". */
  requestDeleteWithContents: (frameId: string) => void;
  spawn: (frameId: string, kind: "terminal" | "agent") => void;
}

const noop = () => {};

export const FrameActionsContext = createContext<FrameActions>({
  rename: noop,
  recolor: noop,
  fit: noop,
  deleteKeepMembers: noop,
  requestDeleteWithContents: noop,
  spawn: noop,
});

export const useFrameActions = (): FrameActions => useContext(FrameActionsContext);
