"use client";
import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Edge, Node } from "@xyflow/react";
import { canvasFrameNoticeStore } from "../services/canvas-frame-notice-store";
import { appendEmptyFrameAt, appendFrameInBox } from "../services/canvas-frame-switcher";
import {
  applyMembershipChanges,
  canCreateFrame,
  dissolveFrames,
  fitFrameToContent,
  frameCreateBlock,
  frameMembers,
  frameOverlapNotice,
  moveNodesToFrame,
  recolorFrame,
  renameFrame,
  tryCreateFrameFromSelection,
  type FrameMoveResult,
  type FrameSeed,
  type MembershipChange,
} from "../services/canvas-frames";

interface FrameOpsDeps {
  setNodes: Dispatch<SetStateAction<Node[]>>;
  nodesRef: { current: Node[] };
  edgesRef: { current: Edge[] };
  autosaveRef: { current: (nodes: Node[], edges: Edge[]) => void };
  /** Closes one node and its runtime session. */
  removeNode: (id: string) => Promise<boolean>;
}

/**
 * Frame mutations on the board (ADR-0050): create, edit, move nodes in and out, delete. Each is one
 * `setNodes` through the autosave choke point, so history sees the new node data and every edit
 * undoes with the shared Cmd+Z where history manages it. Extracted from useCanvasNodes, which keeps
 * only what a Frame touches inside node creation and drag handling.
 */
export function useCanvasFrameOps({ setNodes, nodesRef, edgesRef, autosaveRef, removeNode }: FrameOpsDeps) {
  const commit = useCallback(
    (edit: (nds: Node[]) => Node[]) => {
      setNodes((nds) => {
        const next = edit(nds);
        autosaveRef.current(next, edgesRef.current);
        return next;
      });
    },
    [setNodes, autosaveRef, edgesRef],
  );

  /**
   * Wrap `ids` in a new Frame. Returns the Frame id, or null when nothing wrappable was selected or
   * the create was refused (Frame limit, overlap with another Frame): a refusal raises a notice.
   */
  const createFrame = useCallback(
    (ids: string[], seed?: FrameSeed): string | null => {
      // `nodesRef` can be a render behind a node created in this same tick (spawn bridge), so an id it
      // does not know yet may still be wrappable: only refuse when every id is known and none qualifies.
      const known = nodesRef.current;
      const wanted = new Set(ids);
      const hasPending = ids.some((id) => !known.some((n) => n.id === id));
      if (!hasPending && !canCreateFrame(known.filter((n) => wanted.has(n.id)))) return null;
      // The limit is part of the dry run (a Frame the selection empties is replaced, so it does not count).
      // With a node still pending there is no dry run, and the plain limit is the best known answer.
      const limit = hasPending ? frameCreateBlock(known) : null;
      if (limit) {
        canvasFrameNoticeStore.show(limit);
        return null;
      }
      if (!hasPending) {
        const dry = tryCreateFrameFromSelection(known, ids, "dry-run", seed);
        if (!dry.ok) {
          canvasFrameNoticeStore.show(dry.message);
          return null;
        }
      }
      const frameId = crypto.randomUUID();
      setNodes((nds) => {
        const r = tryCreateFrameFromSelection(nds, ids, frameId, seed);
        if (!r.ok) {
          // Not from inside the updater: StrictMode runs it twice, and an updater must stay pure.
          if (r.reason !== "nothing") queueMicrotask(() => canvasFrameNoticeStore.show(r.message));
          return nds;
        }
        autosaveRef.current(r.nodes, edgesRef.current);
        return r.nodes;
      });
      return frameId;
    },
    [setNodes, nodesRef, autosaveRef, edgesRef],
  );

  // The Frame Switcher's "+": a new empty Frame in the free space nearest `centre`. Null at the limit.
  const addEmptyFrame = useCallback(
    (centre: { x: number; y: number }): string | null => {
      const limit = frameCreateBlock(nodesRef.current);
      if (limit) {
        canvasFrameNoticeStore.show(limit);
        return null;
      }
      const frameId = crypto.randomUUID();
      commit((nds) => appendEmptyFrameAt(nds, frameId, centre));
      return frameId;
    },
    [commit, nodesRef],
  );

  // The Frame tool: an empty Frame filling a dragged box. Null at the limit or on top of another Frame.
  const addFrameInBox = useCallback(
    (box: { x: number; y: number; w: number; h: number }): string | null => {
      const refusal = frameCreateBlock(nodesRef.current) ?? frameOverlapNotice(nodesRef.current, box);
      if (refusal) {
        canvasFrameNoticeStore.show(refusal);
        return null;
      }
      const frameId = crypto.randomUUID();
      commit((nds) => appendFrameInBox(nds, frameId, box));
      return frameId;
    },
    [commit, nodesRef],
  );

  // Drag in/out of a Frame, and its Undo.
  const applyFrameMembership = useCallback(
    (changes: readonly MembershipChange[], direction: "forward" | "reverse") => {
      if (changes.length === 0) return;
      commit((nds) => applyMembershipChanges(nds, changes, direction));
    },
    [commit],
  );

  /**
   * Send nodes into a Frame (⌥⇧N, NL "move into"), or out of theirs when `frameId` is undefined.
   * Going in also moves them inside the Frame and grows it to fit. Returns what changed plus an
   * `undo` that restores positions, membership and the Frame's size; no changes = nothing happened.
   */
  const sendNodesToFrame = useCallback(
    (ids: readonly string[], frameId: string | undefined): Pick<FrameMoveResult, "changes"> & { undo: () => void } => {
      const result = moveNodesToFrame(nodesRef.current, ids, frameId);
      if (result.changes.length === 0) return { changes: [], undo: () => {} };
      commit((nds) => moveNodesToFrame(nds, ids, frameId).nodes);
      return { changes: result.changes, undo: () => commit(result.undo) };
    },
    [commit, nodesRef],
  );

  const renameFrameNode = useCallback((id: string, title: string) => commit((nds) => renameFrame(nds, id, title)), [commit]);
  const recolorFrameNode = useCallback((id: string, colorId: string) => commit((nds) => recolorFrame(nds, id, colorId)), [commit]);
  const fitFrameNode = useCallback((id: string) => commit((nds) => fitFrameToContent(nds, id)), [commit]);

  /** "Delete with contents": close every member's runtime session, then drop the Frame. NOT undoable. */
  const deleteFrameAndContents = useCallback(
    async (frameId: string) => {
      const members = frameMembers(nodesRef.current, frameId);
      const closed = await Promise.all(members.map((member) => removeNode(member.id)));
      if (closed.every(Boolean)) await removeNode(frameId);
    },
    [nodesRef, removeNode],
  );

  const dissolveFrame = useCallback((ids: string[]) => commit((nds) => dissolveFrames(nds, ids)), [commit]);

  return {
    createFrame,
    addEmptyFrame,
    addFrameInBox,
    applyFrameMembership,
    sendNodesToFrame,
    renameFrameNode,
    recolorFrameNode,
    fitFrameNode,
    deleteFrameAndContents,
    dissolveFrame,
  };
}
