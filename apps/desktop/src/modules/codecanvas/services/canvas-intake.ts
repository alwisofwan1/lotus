import type { DraggedSkill } from "../hooks/useCanvasSkillDnd";

/** Image either already on disk (OS drop) or as base64 bytes (clipboard paste). */
export type CanvasImageRef =
  | { kind: "path"; path: string }
  | { kind: "bytes"; name: string; mime: string; base64: string };

/** The minimal transfer surface a paste (DataTransfer) and a Tauri OS-drop both map onto. */
export interface IntakeSource {
  types: readonly string[];
  files: File[];
  /** Absolute paths from a Tauri OS file-drop; empty for clipboard/HTML sources. */
  paths?: string[];
  getString(type: string): string;
}

/** Pure classification of what came in — bytes are NOT read yet (image-files stay handles). */
export type CanvasIntakeIntent =
  | { kind: "image-files"; files: File[] }
  | { kind: "image-paths"; paths: string[] }
  | { kind: "file-paths"; paths: string[] }
  | { kind: "url"; url: string }
  | { kind: "text"; text: string }
  | { kind: "none" };

/** The resolved content handed to a Canvas Node Intake Adapter. */
export type CanvasIntakePayload =
  | { kind: "skill"; skill: DraggedSkill }
  | { kind: "text"; text: string }
  | { kind: "url"; url: string }
  | { kind: "image"; images: CanvasImageRef[] }
  | { kind: "file"; paths: string[] }
  | { kind: "none" };

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "avif"]);

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(extensionOf(path));
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/** PURE — the intake test surface. Decides the kind from metadata without reading bytes. */
export function classifyIntake(src: IntakeSource): CanvasIntakeIntent {
  const paths = src.paths ?? [];
  if (paths.length > 0) {
    const images = paths.filter(isImagePath);
    if (images.length > 0) return { kind: "image-paths", paths: images };
    return { kind: "file-paths", paths };
  }

  const imageFiles = (src.files ?? []).filter((file) => file.type.startsWith("image/"));
  if (imageFiles.length > 0) return { kind: "image-files", files: imageFiles };

  const uriList = src.getString("text/uri-list").trim();
  if (uriList) {
    const first = uriList.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
    if (first) return { kind: "url", url: first.trim() };
  }

  const text = src.getString("text/plain");
  if (text && looksLikeUrl(text)) return { kind: "url", url: text.trim() };
  if (text && text.length > 0) return { kind: "text", text };

  return { kind: "none" };
}

/** True when focus is in a text field — so a text/url paste flows natively instead of being hijacked. */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== "string") return false;
  const node = el as HTMLElement;
  const tag = node.tagName.toLowerCase();
  return tag === "textarea" || tag === "input" || node.isContentEditable === true;
}

/**
 * True when the target sits inside a Note rich editor. An image pasted there should EMBED into the
 * note (TipTap handles it) rather than being hijacked into a canvas image shape. Everywhere else
 * (a focused terminal's xterm textarea, or nothing focused) an image paste becomes a shape.
 */
export function isNoteEditorTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  return !!node && typeof node.closest === "function" && node.closest(".canvas-note-editor") !== null;
}

/**
 * True when focus is inside a terminal agent's xterm. A paste there should go to the agent
 * (normal terminal behavior — Claude Code attaches the image) rather than becoming a canvas shape.
 * `.xterm` is xterm.js's root element class (both the legacy and v2 renderers use it).
 */
export function isTerminalFocusTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  return !!node && typeof node.closest === "function" && node.closest(".xterm") !== null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/** Thin async adapter — reads pasted image File handles into base64 bytes. */
export async function resolveIntakeImages(files: File[]): Promise<CanvasImageRef[]> {
  return Promise.all(
    files.map(async (file) => ({
      kind: "bytes" as const,
      name: file.name,
      mime: file.type || "application/octet-stream",
      base64: await fileToBase64(file),
    })),
  );
}

/** Resolve a classified intent into the payload adapters consume (async only for pasted images). */
export async function resolveIntakePayload(intent: CanvasIntakeIntent): Promise<CanvasIntakePayload> {
  switch (intent.kind) {
    case "image-files":
      return { kind: "image", images: await resolveIntakeImages(intent.files) };
    case "image-paths":
      return { kind: "image", images: intent.paths.map((path) => ({ kind: "path" as const, path })) };
    case "file-paths":
      return { kind: "file", paths: intent.paths };
    case "url":
      return { kind: "url", url: intent.url };
    case "text":
      return { kind: "text", text: intent.text };
    case "none":
      return { kind: "none" };
  }
}
