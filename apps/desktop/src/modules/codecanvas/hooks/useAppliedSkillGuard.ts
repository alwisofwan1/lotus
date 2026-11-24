"use client";
import { useCallback, useState } from "react";

export interface AppliedSkillGuard {
  isApplied: (terminalId: string, skill: string) => boolean;
  /** All skills applied to a node — the run-prompt source for agent nodes. */
  listApplied: (terminalId: string) => string[];
  markApplied: (terminalId: string, skill: string) => void;
  clearApplied: (terminalId: string, skill: string) => void;
  resetTerminal: (terminalId: string) => void;
}

/** Per-terminal, session-only set of skills already delivered via Canvas Skill Prompt Append. */
export function useAppliedSkillGuard(): AppliedSkillGuard {
  const [applied, setApplied] = useState<Map<string, Set<string>>>(new Map());

  const isApplied = useCallback(
    (terminalId: string, skill: string) => !!applied.get(terminalId)?.has(skill),
    [applied],
  );

  const listApplied = useCallback(
    (terminalId: string) => [...(applied.get(terminalId) ?? [])],
    [applied],
  );

  const markApplied = useCallback((terminalId: string, skill: string) => {
    setApplied((cur) => {
      const next = new Map(cur);
      const set = new Set(next.get(terminalId) ?? []);
      set.add(skill);
      next.set(terminalId, set);
      return next;
    });
  }, []);

  const clearApplied = useCallback((terminalId: string, skill: string) => {
    setApplied((cur) => {
      const set = cur.get(terminalId);
      if (!set?.has(skill)) return cur;
      const next = new Map(cur);
      const nextSet = new Set(set);
      nextSet.delete(skill);
      next.set(terminalId, nextSet);
      return next;
    });
  }, []);

  const resetTerminal = useCallback((terminalId: string) => {
    setApplied((cur) => {
      if (!cur.has(terminalId)) return cur;
      const next = new Map(cur);
      next.delete(terminalId);
      return next;
    });
  }, []);

  return { isApplied, listApplied, markApplied, clearApplied, resetTerminal };
}
