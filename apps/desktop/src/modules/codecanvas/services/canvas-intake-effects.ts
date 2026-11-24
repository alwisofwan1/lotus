import { formatSkillInvocation, skillInvocationStyleFor } from "./skills/skill-invocation";
import type { CanvasImageRef } from "./canvas-intake";
import { formatPathsForPrompt, type IntakeExecutorContext } from "./canvas-node-intake";
import type { DraggedSkill } from "../hooks/useCanvasSkillDnd";
import { canvasImagesToNoteAssetMarkdown } from "./note-assets";

/** What an effect needs to know about the target node, decoupled from React Flow. */
export interface CanvasIntakeNodeView {
  type?: string;
  content?: unknown;
  runtimePaneId?: unknown;
  /** "live" = interactive PTY persona; live agents get skills inserted into their prompt (ADR-0027 Phase 6). */
  executionMode?: unknown;
  /** The agent's CLI runner — decides the skill invocation idiom (Claude `/skill` vs a file reference). */
  runner?: unknown;
}

export interface CanvasIntakeEffectDeps {
  getNode: (id: string) => CanvasIntakeNodeView | null;
  setNoteContent: (id: string, content: string) => void;
  writeToPane: (paneId: string, text: string) => void;
  getPaneInput?: (paneId: string) => string;
  markApplied: (id: string, skillName: string) => void;
  /** Types text into a live agent's prompt WITHOUT submitting (insert /skill or a skill reference). */
  insertIntoAgent?: (id: string, text: string) => void;
  collectAttachment: (id: string, images: CanvasImageRef[]) => void;
  projectId?: string | null;
}

export function formatSkillPromptAppend(skillName: string, currentInput = ""): string {
  const normalizedName = skillName.trim().replace(/^\/+/, "");
  if (!normalizedName) return "";
  if (/(^|\s)\/$/.test(currentInput)) return `${normalizedName} `;
  const prefix = currentInput.length > 0 && !/\s$/.test(currentInput) ? " " : "";
  return `${prefix}/${normalizedName} `;
}


/**
 * The text inserted into a LIVE agent's prompt to apply a skill (ADR-0027 Phase 6a) — inserted, not
 * submitted, so the user can add context then press Enter.
 *
 * Runner-aware: Claude family gets `/skill-name`, Codex gets `$skill-name`, and a runner with no
 * skill registry of its own gets a path reference. The per-runner table lives in
 * `skills/skill-invocation.ts` so the Skills list prints exactly the token this inserts.
 */
export function formatSkillForRunner(runner: unknown, skill: Pick<DraggedSkill, "name" | "path">): string {
  return formatSkillInvocation(skillInvocationStyleFor(runner), skill);
}

export function appendMarkdownBlock(current: string, block: string): string {
  const trimmedBlock = block.trim();
  if (!trimmedBlock) return current;
  const trimmedCurrent = current.trimEnd();
  return trimmedCurrent ? `${trimmedCurrent}\n\n${trimmedBlock}` : trimmedBlock;
}

/** Assemble the impure intake effects from injected dependencies (the notice is added by the hook). */
export function buildCanvasIntakeEffects(deps: CanvasIntakeEffectDeps): Omit<IntakeExecutorContext, "notify"> {
  const paneOf = (id: string): string => {
    const pane = deps.getNode(id)?.runtimePaneId;
    return typeof pane === "string" ? pane : id;
  };
  return {
    appendNoteText: (id, text) => {
      const current = String(deps.getNode(id)?.content ?? "");
      deps.setNoteContent(id, current ? `${current}\n${text}` : text);
    },
    appendNoteImages: async (id, images) => {
      const projectId = deps.projectId;
      if (!projectId) throw new Error("No active CodeCanvas project is available.");
      const markdown = await canvasImagesToNoteAssetMarkdown(projectId, images);
      const count = markdown ? images.length : 0;
      if (count > 0) {
        const current = String(deps.getNode(id)?.content ?? "");
        deps.setNoteContent(id, appendMarkdownBlock(current, markdown));
      }
      return count;
    },
    writePty: (id, text) => deps.writeToPane(paneOf(id), text),
    applySkill: (id, skill) => {
      const node = deps.getNode(id);
      if (node?.type === "terminal") {
        // A Terminal gets the slash-command written to its PTY input (Canvas Skill Prompt Append).
        const paneId = paneOf(id);
        const text = formatSkillPromptAppend(skill.name, deps.getPaneInput?.(paneId) ?? "");
        if (text) deps.writeToPane(paneId, text);
      } else if (node?.type === "agent" && node.executionMode === "live") {
        // Runner-first (ADR-0027 Phase 6a): a live agent has no baked prompt, so the skill is INSERTED
        // into its prompt (NOT submitted) — like a terminal — so the user can add context then Enter.
        // Runner-aware: Claude → `/skill`, Codex → `$skill`, others → a path reference.
        const text = formatSkillForRunner(node.runner, skill);
        if (text) deps.insertIntoAgent?.(id, text);
      }
      // A headless agent keeps the guard set as its applied-skills source for the run prompt (dormant
      // graph path); marking applied also drives the "applied" badge for every target type.
      deps.markApplied(id, skill.name);
    },
    addAttachment: (id, images) => {
      const node = deps.getNode(id);
      // A LIVE agent runs an interactive PTY and never drains the (headless-only) attachment store,
      // so an image dropped on it must be TYPED into its prompt as a file path — exactly like a real
      // terminal drag. Claude Code then attaches the file. Insert (no submit) so the user can add
      // context. Only on-disk paths can be typed; pasted bytes fall back to the headless collector.
      if (node?.type === "agent" && node.executionMode === "live") {
        const paths = images.filter((img): img is { kind: "path"; path: string } => img.kind === "path").map((img) => img.path);
        if (paths.length > 0) {
          // Double-quoted so a path with spaces (macOS "Application Support") reaches Claude intact.
          deps.insertIntoAgent?.(id, `${formatPathsForPrompt(paths)} `);
          return;
        }
      }
      deps.collectAttachment(id, images);
    },
  };
}
