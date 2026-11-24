import { codecanvasImportNoteAssetPath, codecanvasReadNoteAsset, codecanvasSaveNoteAsset } from "@/lib/tauri/codecanvas";
import type { CanvasImageRef } from "./canvas-intake";

const SCHEME = "lotus-note-asset://";
const ASSET_URI_RE = /lotus-note-asset:\/\/([A-Za-z0-9_.-]+)/g;
const MARKDOWN_IMAGE_ASSET_RE = /!\[([^\]]*)\]\(lotus-note-asset:\/\/([A-Za-z0-9_.-]+)(?:\s+["'][^"']*["'])?\)/g;

export interface NoteAssetRef {
  id: string;
  alt?: string;
}

export function noteAssetUri(assetId: string): string {
  return `${SCHEME}${assetId}`;
}

export function parseNoteAssetUri(src: string): string | null {
  return src.startsWith(SCHEME) ? src.slice(SCHEME.length) || null : null;
}

export function extractNoteAssetIds(markdown: string): string[] {
  return [...markdown.matchAll(ASSET_URI_RE)].map((match) => match[1]);
}

export function extractNoteAssetRefs(markdown: string): NoteAssetRef[] {
  const refs: NoteAssetRef[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_ASSET_RE)) {
    const id = match[2];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const alt = match[1]?.trim();
    refs.push(alt ? { id, alt } : { id });
  }
  for (const id of extractNoteAssetIds(markdown)) {
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push({ id });
  }
  return refs;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.onload = () => resolve(String(reader.result).split(",").at(1) ?? "");
    reader.readAsDataURL(file);
  });
}

export async function dataUrlToNoteAssetUri(projectId: string, dataUrl: string, originalName = "pasted-image.png"): Promise<string | null> {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  const asset = await codecanvasSaveNoteAsset({
    projectId,
    originalName,
    mime: match[1],
    base64: match[2],
  });
  return noteAssetUri(asset.id);
}

export async function imagePathToNoteAssetUri(projectId: string, path: string): Promise<string> {
  const asset = await codecanvasImportNoteAssetPath({ projectId, path });
  return noteAssetUri(asset.id);
}

export async function imageFileToNoteAssetUri(projectId: string, file: File): Promise<string> {
  const asset = await codecanvasSaveNoteAsset({
    projectId,
    originalName: file.name || "image.png",
    mime: file.type || "image/png",
    base64: await fileToBase64(file),
  });
  return noteAssetUri(asset.id);
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || "image";
}

function markdownAlt(value: string): string {
  return (value.trim() || "image")
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[\[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "image";
}

export async function canvasImageRefToNoteAsset(projectId: string, image: CanvasImageRef): Promise<{ uri: string; alt: string }> {
  if (image.kind === "path") return { uri: await imagePathToNoteAssetUri(projectId, image.path), alt: markdownAlt(basename(image.path)) };
  const asset = await codecanvasSaveNoteAsset({
    projectId,
    originalName: image.name || "image.png",
    mime: image.mime || "image/png",
    base64: image.base64,
  });
  return { uri: noteAssetUri(asset.id), alt: markdownAlt(image.name || asset.originalName || asset.fileName || asset.id) };
}

export async function canvasImagesToNoteAssetMarkdown(projectId: string, images: CanvasImageRef[]): Promise<string> {
  const rows = await Promise.all(images.map((image) => canvasImageRefToNoteAsset(projectId, image)));
  return rows.map(({ uri, alt }) => `![${alt}](${uri})`).join("\n\n");
}

/**
 * Read a stored note-asset back and measure its intrinsic pixel dimensions (loads the bitmap).
 * Returns null when unavailable (no DOM, missing asset, decode failure) — the caller falls back
 * to a default display box. Used to size a pasted/dropped image shape to its true aspect ratio.
 */
export async function measureNoteAssetImage(assetUri: string): Promise<{ width: number; height: number } | null> {
  const id = parseNoteAssetUri(assetUri);
  if (!id || typeof Image === "undefined") return null;
  try {
    const res = await codecanvasReadNoteAsset(id);
    const dataUrl = `data:${res.asset.mime || "image/png"};base64,${res.base64}`;
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  } catch {
    return null;
  }
}

export async function resolveNoteAssetImageRefs(assetIds: string[]): Promise<CanvasImageRef[]> {
  const unique = [...new Set(assetIds.filter(Boolean))];
  const settled = await Promise.allSettled(unique.map((assetId) => codecanvasReadNoteAsset(assetId)));
  return settled.flatMap((result): CanvasImageRef[] => {
    if (result.status !== "fulfilled") return [];
    return [{
      kind: "bytes",
      name: result.value.asset.originalName || result.value.asset.fileName || result.value.asset.id,
      mime: result.value.asset.mime || "image/png",
      base64: result.value.base64,
    }];
  });
}
