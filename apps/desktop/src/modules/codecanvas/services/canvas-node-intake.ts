import type { CanvasImageRef, CanvasIntakePayload } from "./canvas-intake";
import type { DraggedSkill } from "../hooks/useCanvasSkillDnd";

/** The typed effect an adapter returns; a single executor applies it (adapters stay pure). */
export type IntakeOutcome =
  | { kind: "append-text"; text: string }
  | { kind: "append-note-images"; images: CanvasImageRef[] }
  | { kind: "write-pty"; text: string }
  | { kind: "apply-skill"; skill: DraggedSkill }
  | { kind: "add-attachment"; images: CanvasImageRef[] }
  | { kind: "reject"; reason: string };

export type CanvasNodeIntakeKind = "note" | "terminal" | "agent" | "skills" | "skill" | "plan";

const REJECT_READONLY: IntakeOutcome = { kind: "reject", reason: "This node doesn't accept dropped content." };

/**
 * Format file paths for typing into an agent/terminal PROMPT. Each path is double-quoted (and inner
 * quotes/backslashes escaped) so a path with spaces — e.g. macOS "~/Library/Application Support/…" —
 * reaches the agent as ONE argument. Claude Code (and shells) split unquoted spaces, so without this
 * the image never loads. Space-joined for multiple paths.
 */
export function formatPathsForPrompt(paths: readonly string[]): string {
  return paths.map((p) => `"${p.replace(/([\\"])/g, "\\$1")}"`).join(" ");
}

function noteIntake(payload: CanvasIntakePayload): IntakeOutcome {
  switch (payload.kind) {
    case "text": return { kind: "append-text", text: payload.text };
    case "url": return { kind: "append-text", text: payload.url };
    case "file": return { kind: "append-text", text: payload.paths.join("\n") };
    case "image": return { kind: "append-note-images", images: payload.images };
    case "skill": return { kind: "reject", reason: "Notes hold no skills — drop it on a terminal or agent." };
    case "none": return { kind: "reject", reason: "Nothing recognizable to add." };
  }
}

function terminalIntake(payload: CanvasIntakePayload): IntakeOutcome {
  switch (payload.kind) {
    case "skill": return { kind: "apply-skill", skill: payload.skill };
    case "text": return { kind: "write-pty", text: payload.text };
    case "url": return { kind: "write-pty", text: payload.url };
    case "file": return { kind: "write-pty", text: formatPathsForPrompt(payload.paths) };
    case "image": {
      // A terminal can only type a path; pasted bytes have none until the attachment store stages them.
      if (payload.images.every((img) => img.kind === "path")) {
        return { kind: "write-pty", text: formatPathsForPrompt(payload.images.map((img) => (img as { path: string }).path)) };
      }
      return { kind: "reject", reason: "Pasting an image into a terminal needs staging (coming with attachments)." };
    }
    case "none": return { kind: "reject", reason: "Nothing recognizable to add." };
  }
}

function agentIntake(payload: CanvasIntakePayload): IntakeOutcome {
  switch (payload.kind) {
    case "skill": return { kind: "apply-skill", skill: payload.skill };
    case "image": return { kind: "add-attachment", images: payload.images };
    case "text":
    case "url": return { kind: "reject", reason: "Wire a Note into the agent for context instead of dropping text." };
    case "file": return { kind: "reject", reason: "File attachments arrive with the attachment model." };
    case "none": return { kind: "reject", reason: "Nothing recognizable to add." };
  }
}

/** PURE registry — maps a Canvas Intake Payload to an Intake Outcome for one node kind. */
export function acceptIntake(kind: CanvasNodeIntakeKind, payload: CanvasIntakePayload): IntakeOutcome {
  switch (kind) {
    case "note": return noteIntake(payload);
    case "terminal": return terminalIntake(payload);
    case "agent": return agentIntake(payload);
    case "skills":
    case "skill":
    case "plan": return REJECT_READONLY;
  }
}

/**
 * What to do with a dropped/pasted payload when it lands on EMPTY canvas (no node under the
 * pointer, none hovered, none selected). Images become a first-class whiteboard image shape;
 * everything else that a Note can hold falls back to creating a Note target (prior behavior).
 */
export type IntakeFallback =
  | { kind: "image-shape"; images: CanvasImageRef[] }
  | { kind: "note-target" }
  | { kind: "none" };

/**
 * Where a DROPPED image goes, given the node under the drop point. A file PATH dropped onto a
 * PTY-backed target (terminal or agent) is delivered to that prompt (like dragging a file into any
 * terminal — Claude Code then reads it). Everything else — pasted bytes (no path to type), a
 * non-PTY node, or empty canvas — becomes a placed image shape (CNVS). Non-image payloads never
 * reach here.
 */
export function resolveImageDropRoute(payload: CanvasIntakePayload, target: { kind: CanvasNodeIntakeKind } | null): "node" | "shape" {
  if (payload.kind !== "image") return "shape";
  const isPtyTarget = !!target && (target.kind === "terminal" || target.kind === "agent");
  const everyIsPath = payload.images.length > 0 && payload.images.every((img) => img.kind === "path");
  return isPtyTarget && everyIsPath ? "node" : "shape";
}

/** PURE — decide the empty-canvas fallback for a resolved payload. */
export function resolveIntakeFallback(payload: CanvasIntakePayload): IntakeFallback {
  switch (payload.kind) {
    case "image": return { kind: "image-shape", images: payload.images };
    case "text":
    case "url":
    case "file": return { kind: "note-target" };
    case "skill":
    case "none": return { kind: "none" };
  }
}

/** The injected effects the executor applies — the only impure surface of the intake seam. */
export interface IntakeExecutorContext {
  appendNoteText(nodeId: string, text: string): void;
  appendNoteImages(nodeId: string, images: CanvasImageRef[]): Promise<number> | number;
  writePty(nodeId: string, text: string): void;
  applySkill(nodeId: string, skill: DraggedSkill): void;
  addAttachment(nodeId: string, images: CanvasImageRef[]): void;
  notify(message: string): void;
}

function formatIntakeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "unknown error";
}

/** Apply one Intake Outcome through injected callbacks. Adapters decide; this executes. */
export async function applyIntakeOutcome(nodeId: string, outcome: IntakeOutcome, ctx: IntakeExecutorContext): Promise<void> {
  switch (outcome.kind) {
    case "append-text": return ctx.appendNoteText(nodeId, outcome.text);
    case "append-note-images": {
      try {
        const count = await ctx.appendNoteImages(nodeId, outcome.images);
        ctx.notify(`Embedded ${count} image${count === 1 ? "" : "s"} in the Note. Image assets are available to connected agents.`);
      } catch (error) {
        ctx.notify(`Could not embed image in Note: ${formatIntakeError(error)}`);
      }
      return;
    }
    case "write-pty": return ctx.writePty(nodeId, outcome.text);
    case "apply-skill": return ctx.applySkill(nodeId, outcome.skill);
    case "add-attachment": return ctx.addAttachment(nodeId, outcome.images);
    case "reject": return ctx.notify(outcome.reason);
  }
}

/** Single entry the channels share: classify-then-route a resolved payload to one node. */
export async function routeIntake(
  kind: CanvasNodeIntakeKind,
  nodeId: string,
  payload: CanvasIntakePayload,
  ctx: IntakeExecutorContext,
): Promise<IntakeOutcome> {
  const outcome = acceptIntake(kind, payload);
  await applyIntakeOutcome(nodeId, outcome, ctx);
  return outcome;
}
