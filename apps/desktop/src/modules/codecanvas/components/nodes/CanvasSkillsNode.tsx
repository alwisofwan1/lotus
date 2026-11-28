"use client";
import { memo, useCallback, useMemo, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { NodeProps } from "@xyflow/react";
import { X, RefreshCw, Check, Sparkles, Search, GripVertical, CornerDownLeft, Maximize2 } from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import { SKILL_DRAG_PREFIX } from "@/modules/codecanvas/hooks/useCanvasSkillDnd";
import { useCanvasSkillBrowser } from "@/modules/codecanvas/hooks/useCanvasSkillBrowser";
import type { SkillSourceFilter } from "@/modules/codecanvas/services/skills/skill-search";
import {
  skillDisplayToken,
  skillInvocationStyleFor,
  type SkillInvocationStyle,
} from "@/modules/codecanvas/services/skills/skill-invocation";
import type { SkillEntry } from "@/lib/tauri/skills";
import { WorkbenchMarkdownPreview } from "@/modules/codespace/components/workbench/WorkbenchMarkdownPreview";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";
import type { CanvasSkillPreview, CanvasSkillsNodeData } from "../../types/canvas";

const SOURCE_FILTERS: { id: SkillSourceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "project", label: "Project" },
  { id: "global", label: "Global" },
];

function toPreview(skill: SkillEntry): CanvasSkillPreview {
  return {
    name: skill.name,
    source: skill.source,
    content: skill.content,
    description: skill.description,
    path: skill.path,
    metadata: skill.metadata,
  };
}

/**
 * The Skills browser, as a master-detail node.
 *
 * It used to be a bare scrolling list whose only affordances were "click to spawn a
 * second node" and "drag onto a terminal". Reading a skill therefore always cost a
 * new node placed to the right, and the camera re-framed three nodes at once to show
 * it — the board appeared to fly away. Selecting now previews *in place*; spawning a
 * separate reader is the opt-in "pop out" action, and applying no longer requires a
 * drag at all.
 *
 * occlusion-exempt: the `role="listbox"` here is the node's own list column, laid out
 * inside the node body and clipped by the frame — not a floating menu that escapes over
 * the canvas. It needs no occlusion lock; it sits under a native Browser Node WebView
 * exactly like every other node's content does.
 */
export const CanvasSkillsNode = memo(function CanvasSkillsNode({ id, data, selected }: NodeProps) {
  const {
    parentTerminalId, cwd, dispatchCommand, onOpenSkill, isSkillApplied, onReEnableSkill, onClose,
    parentRunner, parentClaudeFamily,
  } = data as CanvasSkillsNodeData;
  // One style for the whole node: the list prints exactly the token an apply inserts,
  // so there is no way for the two to disagree.
  const invocation = useMemo(
    () => skillInvocationStyleFor(parentRunner, parentClaudeFamily),
    [parentRunner, parentClaudeFamily],
  );
  const browser = useCanvasSkillBrowser(cwd);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Applying an already-applied skill is allowed, on purpose. The guard remembers what was SENT;
  // it cannot see the operator deleting the token again, so refusing here stranded the skill for
  // the rest of the session behind a re-enable button most people never found.
  const applySkill = useCallback(
    (skill: SkillEntry) => {
      browser.markUsed(skill.name);
      dispatchCommand?.({ kind: "apply-skill", targetId: parentTerminalId, skill: toPreview(skill) });
    },
    [browser, dispatchCommand, parentTerminalId],
  );

  const popOutSkill = useCallback(
    (skill: SkillEntry) => {
      browser.markUsed(skill.name);
      const preview = toPreview(skill);
      if (dispatchCommand) dispatchCommand({ kind: "open-skill", skillsNodeId: id, skill: preview });
      else onOpenSkill?.(id, preview);
    },
    [browser, dispatchCommand, id, onOpenSkill],
  );

  const reEnableSkill = useCallback(
    (name: string) => {
      if (dispatchCommand) dispatchCommand({ kind: "reenable-skill", terminalId: parentTerminalId, skillName: name });
      else onReEnableSkill?.(parentTerminalId, name);
    },
    [dispatchCommand, onReEnableSkill, parentTerminalId],
  );

  const closeNode = useCallback(() => {
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  }, [dispatchCommand, id, onClose]);

  // The node lives inside ReactFlow, which owns Backspace/Delete/arrow keys at the
  // pane level — every key handled here must be stopped before it reaches the board.
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const { key } = event;
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        browser.moveActive(key === "ArrowDown" ? 1 : -1);
        scrollActiveIntoView(listRef.current);
        return;
      }
      if (key === "Enter" && browser.active) {
        event.preventDefault();
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey) popOutSkill(browser.active);
        else applySkill(browser.active);
        return;
      }
      if (key === "Escape") {
        event.stopPropagation();
        // Escape peels one layer at a time: clear the search, then close the node.
        if (browser.query) browser.setQuery("");
        else closeNode();
      }
    },
    [applySkill, browser, closeNode, popOutSkill],
  );

  const total = browser.counts.all;
  // While browsing, the reader already shows the selected skill's description, so
  // repeating it on every row is noise in a narrow column. While SEARCHING it is the
  // evidence for why a row matched, so it comes back.
  const searching = browser.query.trim().length > 0;

  return (
    <CanvasNodeFrame
      kind="skills"
      selected={!!selected}
      minWidth={460}
      minHeight={300}
      header={
        <div className="canvas-panel-header canvas-skills-node-header">
          <span className="canvas-panel-title">
            <span className="canvas-node-chip" aria-hidden>
              <Sparkles />
            </span>
            Skills
            {browser.skills && <span className="canvas-panel-count">{total} skills</span>}
          </span>
          <div className="canvas-panel-header-actions">
            <button className="canvas-panel-icon-btn" aria-label="Refresh skills" onClick={browser.reload}>
              <RefreshCw size={11} />
            </button>
            {dispatchCommand && (
              <CanvasNodeFocusAction
                onFocus={() => dispatchCommand({ kind: "focus-node", nodeId: id })}
                className="canvas-panel-icon-btn canvas-node-focus"
              />
            )}
            <button className="canvas-panel-icon-btn" aria-label="Close panel" onClick={closeNode}>
              <X size={11} />
            </button>
          </div>
        </div>
      }
    >
      {/* Keys are handled on the wrapper, not per-row: the node is one composite widget
          whose focus lives in the search input. */}
      <div className="canvas-node-body canvas-skills-node-body nodrag nowheel" onKeyDown={handleKeyDown}>
        <div className="canvas-skills-searchbar">
          <Search size={12} className="canvas-skills-search-icon" aria-hidden />
          <input
            className="canvas-skills-search-input"
            type="search"
            // The node only opens in response to an explicit "show me the skills" action, so
            // typing is the very next thing the user wants.
            autoFocus
            value={browser.query}
            placeholder="Search skills…"
            aria-label="Search skills"
            onChange={(event) => browser.setQuery(event.target.value)}
          />
          <div className="canvas-skills-filters" role="group" aria-label="Filter by source">
            {SOURCE_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className="canvas-skills-filter"
                aria-pressed={browser.source === filter.id}
                onClick={() => browser.setSource(filter.id)}
              >
                {filter.label}
                <span className="canvas-skills-filter-count">
                  {filter.id === "all" ? total : browser.counts[filter.id]}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="canvas-skills-split">
          <div className="canvas-skills-node-list" ref={listRef} role="listbox" aria-label="Skills">
            {browser.skills === null && <p className="canvas-panel-empty">Loading…</p>}
            {browser.skills !== null && total === 0 && (
              <p className="canvas-panel-empty">No skills found for this project.</p>
            )}
            {browser.skills !== null && total > 0 && browser.groups.length === 0 && (
              <p className="canvas-panel-empty">No skill matches “{browser.query}”.</p>
            )}
            {browser.groups.map((group) => (
              <section className="canvas-skill-section" key={group.id}>
                <h4 className="canvas-skill-heading">
                  {group.label} <span>{group.skills.length}</span>
                </h4>
                {group.skills.map((skill) => (
                  <SkillRow
                    key={`${group.id}:${skill.name}`}
                    terminalId={parentTerminalId}
                    skill={skill}
                    active={browser.active?.name === skill.name}
                    invocation={invocation}
                    showDescription={searching}
                    applied={isSkillApplied(parentTerminalId, skill.name)}
                    onSelect={() => browser.selectSkill(skill.name)}
                    onApply={() => applySkill(skill)}
                    onClearApplied={() => reEnableSkill(skill.name)}
                  />
                ))}
              </section>
            ))}
          </div>

          <SkillDetail
            skill={browser.active}
            invocation={invocation}
            applied={!!browser.active && isSkillApplied(parentTerminalId, browser.active.name)}
            onApply={() => browser.active && applySkill(browser.active)}
            onPopOut={() => browser.active && popOutSkill(browser.active)}
            onReEnable={() => browser.active && reEnableSkill(browser.active.name)}
          />
        </div>
      </div>
    </CanvasNodeFrame>
  );
});

function scrollActiveIntoView(list: HTMLDivElement | null) {
  // Runs after the state update paints; a frame is enough and avoids a layout ref per row.
  requestAnimationFrame(() => {
    const row = list?.querySelector('[data-active="true"]');
    // `scrollIntoView` is undefined in jsdom and in older WebViews — optional-call it.
    row?.scrollIntoView?.({ block: "nearest" });
  });
}

function SkillRow({
  terminalId, skill, active, applied, showDescription, invocation, onSelect, onApply, onClearApplied,
}: {
  terminalId: string;
  skill: SkillEntry;
  active: boolean;
  applied: boolean;
  showDescription: boolean;
  invocation: SkillInvocationStyle;
  onSelect: () => void;
  onApply: () => void;
  onClearApplied: () => void;
}) {
  // The drag lives on its own grip, not on the row. Sharing one element meant a
  // 5px pointer slip turned "read this skill" into "apply it to the terminal".
  const token = skillDisplayToken(invocation, skill.name);
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `${SKILL_DRAG_PREFIX}${terminalId}:${skill.name}`,
    data: { skill: { name: skill.name, source: skill.source, content: skill.content, path: skill.path } },
  });

  return (
    <div
      className="canvas-skill-row-wrap"
      data-active={active ? "true" : "false"}
      data-applied={applied ? "true" : "false"}
    >
      <span
        ref={setNodeRef}
        className="canvas-skill-grip"
        aria-label={`Drag ${token} onto a terminal or agent`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={11} aria-hidden />
      </span>
      <button
        type="button"
        className={`canvas-skill-row${showDescription ? " canvas-skill-row--detailed" : ""}`}
        role="option"
        aria-selected={active}
        onClick={onSelect}
        onDoubleClick={onApply}
      >
        <span className="canvas-skill-name">{token}</span>
        {showDescription && skill.description && (
          <span className="canvas-skill-desc">{skill.description}</span>
        )}
      </button>
      {applied && (
        <button
          type="button"
          className="canvas-skill-applied"
          title={`${token} was sent to this node — click to clear the marker`}
          aria-label={`Clear the applied marker on ${token}`}
          onClick={onClearApplied}
        >
          <Check size={9} aria-hidden /> applied
        </button>
      )}
      <button
        type="button"
        className="canvas-skill-apply"
        aria-label={applied ? `Apply ${token} again` : `Apply ${token}`}
        onClick={onApply}
      >
        <CornerDownLeft size={11} aria-hidden />
      </button>
    </div>
  );
}

function SkillDetail({
  skill, applied, invocation, onApply, onPopOut, onReEnable,
}: {
  skill: SkillEntry | null;
  applied: boolean;
  invocation: SkillInvocationStyle;
  onApply: () => void;
  onPopOut: () => void;
  onReEnable: () => void;
}) {
  const shortcut = useFormatShortcut();
  if (!skill) {
    return (
      <div className="canvas-skills-detail canvas-skills-detail--empty">
        <p className="canvas-skill-hint">
          Select a skill to read its SKILL.md. <kbd>⏎</kbd> applies it to this node —{" "}
          {invocation.kind === "sigil" ? (
            <>it inserts <code>{invocation.sigil}skill-name</code></>
          ) : (
            <>this runner has no skill command, so it inserts a reference to the skill file</>
          )}
          , not sent, so you can add context first. Drag the grip to send it somewhere else.
        </p>
      </div>
    );
  }

  return (
    <div className="canvas-skills-detail">
      <div className="canvas-skills-detail-head">
        <span className="canvas-skill-node-name">{skillDisplayToken(invocation, skill.name)}</span>
        <span className={`canvas-skill-badge canvas-skill-badge--${skill.source}`}>
          {skill.source === "project" ? "PROJECT" : "GLOBAL"}
        </span>
        <div className="canvas-skills-detail-actions">
          {applied && (
            <button
              type="button"
              className="canvas-skill-applied"
              title={`${skillDisplayToken(invocation, skill.name)} was sent to this node — click to clear the marker`}
              aria-label={`Clear the applied marker on ${skillDisplayToken(invocation, skill.name)}`}
              onClick={onReEnable}
            >
              <Check size={9} aria-hidden /> applied
            </button>
          )}
          {/* Apply stays available even when applied — re-sending after deleting the token is the
              common case, not an error. */}
          <button type="button" className="canvas-skills-detail-apply" onClick={onApply}>
            {applied ? "Apply again" : "Apply"} <kbd>⏎</kbd>
          </button>
          <button
            type="button"
            className="canvas-panel-icon-btn"
            aria-label={`Pop out ${skillDisplayToken(invocation, skill.name)}`}
            title={`Open as its own node (${shortcut("⌘⏎")})`}
            onClick={onPopOut}
          >
            <Maximize2 size={11} aria-hidden />
          </button>
        </div>
      </div>
      <div className="canvas-skills-detail-body">
        <WorkbenchMarkdownPreview
          content={skill.content}
          className="wbmd-skill-preview"
          metadata={skill.metadata?.length ? skill.metadata : undefined}
          preserveSoftBreaks
        />
      </div>
    </div>
  );
}
