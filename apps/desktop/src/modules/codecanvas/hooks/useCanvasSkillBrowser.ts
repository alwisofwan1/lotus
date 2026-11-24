"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listSkills } from "@/lib/tauri/skills";
import type { SkillEntry } from "@/lib/tauri/skills";
import {
  flattenSkillGroups,
  groupSkills,
  type SkillGroup,
  type SkillSourceFilter,
} from "../services/skills/skill-search";
import { readSkillRecents, recordSkillRecent } from "../services/skills/skill-recents";

export interface UseCanvasSkillBrowserResult {
  /** `null` while the first load is in flight. */
  skills: SkillEntry[] | null;
  groups: SkillGroup[];
  /** The groups flattened — keyboard order, and what `activeIndex` indexes into. */
  visible: SkillEntry[];
  active: SkillEntry | null;
  activeIndex: number;
  query: string;
  source: SkillSourceFilter;
  recents: string[];
  counts: { all: number; project: number; global: number };
  setQuery: (query: string) => void;
  setSource: (source: SkillSourceFilter) => void;
  /** Move the selection by `delta`, clamped to the ends (no wrap — wrapping in a
   *  visible list reads as a jump, and the list is short). */
  moveActive: (delta: number) => void;
  selectSkill: (name: string) => void;
  /** Record a use so the skill floats to Recent next time. */
  markUsed: (name: string) => void;
  reload: () => void;
}

/**
 * State for the Skills node's browser: load, search, filter, and the single
 * selection that drives the detail pane.
 *
 * Selection is stored as a NAME and the index derived from it, not the other way
 * round — a name survives the list re-ordering under it as the user types, where a
 * stored index silently points at a different skill.
 */
export function useCanvasSkillBrowser(cwd: string): UseCanvasSkillBrowserResult {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SkillSourceFilter>("all");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // Scope-stamped so a project switch re-reads storage during render (React's
  // adjust-state-on-prop-change pattern) instead of through an effect, which would
  // render one frame with the previous project's recents.
  const [recentsState, setRecentsState] = useState(() => ({ scope: cwd, names: readSkillRecents(cwd) }));
  const recents = recentsState.scope === cwd ? recentsState.names : readSkillRecents(cwd);
  if (recentsState.scope !== cwd) setRecentsState({ scope: cwd, names: recents });

  const reload = useCallback(() => {
    setSkills(null);
    listSkills(cwd).then(setSkills).catch(() => setSkills([]));
  }, [cwd]);

  useEffect(() => {
    const frame = requestAnimationFrame(reload);
    return () => cancelAnimationFrame(frame);
  }, [reload]);

  const groups = useMemo(
    () => groupSkills(skills ?? [], { query, source, recents }),
    [skills, query, source, recents],
  );
  const visible = useMemo(() => flattenSkillGroups(groups), [groups]);

  // Derived, never stored: the selection falls back to the top result whenever the
  // named skill drops out of the filtered list.
  const activeIndex = useMemo(() => {
    const found = selectedName ? visible.findIndex((skill) => skill.name === selectedName) : -1;
    return found >= 0 ? found : visible.length > 0 ? 0 : -1;
  }, [selectedName, visible]);
  const active = activeIndex >= 0 ? visible[activeIndex] ?? null : null;

  const counts = useMemo(() => {
    const all = skills ?? [];
    return {
      all: all.length,
      project: all.filter((skill) => skill.source === "project").length,
      global: all.filter((skill) => skill.source === "global").length,
    };
  }, [skills]);

  const moveActive = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const next = Math.min(visible.length - 1, Math.max(0, activeIndex + delta));
      setSelectedName(visible[next].name);
    },
    [activeIndex, visible],
  );

  const markUsed = useCallback(
    (name: string) => setRecentsState({ scope: cwd, names: recordSkillRecent(cwd, name) }),
    [cwd],
  );

  return {
    skills,
    groups,
    visible,
    active,
    activeIndex,
    query,
    source,
    recents,
    counts,
    setQuery,
    setSource,
    moveActive,
    selectSkill: setSelectedName,
    markUsed,
    reload,
  };
}
