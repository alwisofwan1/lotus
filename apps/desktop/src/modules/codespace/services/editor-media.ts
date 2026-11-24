/*
 * Files the workbench shows in its media viewer instead of the text editor. Only formats the
 * macOS WebView (WKWebView) decodes natively: an `<img>`, `<video>` or `<audio>` element plays
 * them from a Blob, an `<iframe>` shows a PDF with WebKit's own viewer, and a `FontFace` loads a
 * font — with no decoder shipped in the app. (PDF and fonts checked in a WKWebView under both
 * `http://localhost` and a `tauri://` scheme handler, 2026-10-15.)
 */

export type EditorMediaKind = "image" | "video" | "audio" | "pdf" | "font";

export type EditorMediaType = {
  kind: EditorMediaKind;
  mime: string;
  /** The status bar's name for it, as VS Code shows "PNG Image". */
  label: string;
  /** Text on disk (SVG): opens in the editor, with the viewer as its preview. */
  textual?: boolean;
};

const MEDIA_BY_EXTENSION: Record<string, EditorMediaType> = {
  png: { kind: "image", mime: "image/png", label: "PNG Image" },
  apng: { kind: "image", mime: "image/apng", label: "APNG Image" },
  jpg: { kind: "image", mime: "image/jpeg", label: "JPEG Image" },
  jpeg: { kind: "image", mime: "image/jpeg", label: "JPEG Image" },
  jfif: { kind: "image", mime: "image/jpeg", label: "JPEG Image" },
  gif: { kind: "image", mime: "image/gif", label: "GIF Image" },
  webp: { kind: "image", mime: "image/webp", label: "WebP Image" },
  avif: { kind: "image", mime: "image/avif", label: "AVIF Image" },
  bmp: { kind: "image", mime: "image/bmp", label: "BMP Image" },
  ico: { kind: "image", mime: "image/x-icon", label: "Icon" },
  cur: { kind: "image", mime: "image/x-icon", label: "Cursor" },
  tif: { kind: "image", mime: "image/tiff", label: "TIFF Image" },
  tiff: { kind: "image", mime: "image/tiff", label: "TIFF Image" },
  heic: { kind: "image", mime: "image/heic", label: "HEIC Image" },
  heif: { kind: "image", mime: "image/heif", label: "HEIF Image" },
  svg: { kind: "image", mime: "image/svg+xml", label: "SVG Image", textual: true },
  mp4: { kind: "video", mime: "video/mp4", label: "MP4 Video" },
  m4v: { kind: "video", mime: "video/x-m4v", label: "MP4 Video" },
  mov: { kind: "video", mime: "video/quicktime", label: "QuickTime Video" },
  webm: { kind: "video", mime: "video/webm", label: "WebM Video" },
  mp3: { kind: "audio", mime: "audio/mpeg", label: "MP3 Audio" },
  wav: { kind: "audio", mime: "audio/wav", label: "WAV Audio" },
  m4a: { kind: "audio", mime: "audio/mp4", label: "M4A Audio" },
  aac: { kind: "audio", mime: "audio/aac", label: "AAC Audio" },
  flac: { kind: "audio", mime: "audio/flac", label: "FLAC Audio" },
  ogg: { kind: "audio", mime: "audio/ogg", label: "Ogg Audio" },
  oga: { kind: "audio", mime: "audio/ogg", label: "Ogg Audio" },
  opus: { kind: "audio", mime: "audio/ogg", label: "Opus Audio" },
  aiff: { kind: "audio", mime: "audio/aiff", label: "AIFF Audio" },
  aif: { kind: "audio", mime: "audio/aiff", label: "AIFF Audio" },
  pdf: { kind: "pdf", mime: "application/pdf", label: "PDF Document" },
  ttf: { kind: "font", mime: "font/ttf", label: "TrueType Font" },
  otf: { kind: "font", mime: "font/otf", label: "OpenType Font" },
  woff: { kind: "font", mime: "font/woff", label: "WOFF Font" },
  woff2: { kind: "font", mime: "font/woff2", label: "WOFF2 Font" },
};

export function editorMediaType(filePath: string | null): EditorMediaType | null {
  if (!filePath) return null;
  const fileName = (filePath.split(/[\\/]/).pop() ?? filePath).toLowerCase();
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  return MEDIA_BY_EXTENSION[fileName.slice(dot + 1)] ?? null;
}

/** "1.4 MB", as Finder and VS Code's image preview show a size. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const MEDIA_MIN_ZOOM = 0.05;
export const MEDIA_MAX_ZOOM = 32;
/** The steps ⌘+ / ⌘− and the zoom buttons move through, as VS Code's image preview does. */
const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

export function clampZoom(zoom: number): number {
  return Math.min(MEDIA_MAX_ZOOM, Math.max(MEDIA_MIN_ZOOM, zoom));
}

/** The next step up or down from `zoom`, which may sit between steps after a pinch. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const epsilon = 1e-6;
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom + epsilon) ?? MEDIA_MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - epsilon) ?? MEDIA_MIN_ZOOM;
}

/**
 * The scale that shows the whole image in the viewport. Never above 1: a small icon is shown at
 * its real size, not blown up into a blur.
 */
export function fitZoom(natural: { width: number; height: number }, viewport: { width: number; height: number }): number {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  return clampZoom(Math.min(1, viewport.width / natural.width, viewport.height / natural.height));
}

export type FontNames = { family: string; fullName: string | null };

/**
 * The family and full name a TrueType/OpenType font gives itself (its `name` table), as Font
 * Book shows them. `null` for a compressed WOFF/WOFF2 or anything unreadable: the viewer then
 * uses the file name.
 */
export function readFontNames(bytes: ArrayBuffer): FontNames | null {
  try {
    const view = new DataView(bytes);
    const tag = view.getUint32(0);
    // 0x00010000 TrueType, 'OTTO' CFF OpenType, 'true' old Apple TrueType.
    if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;
    const tables = view.getUint16(4);
    let nameOffset = -1;
    for (let index = 0; index < tables; index += 1) {
      const record = 12 + index * 16;
      if (view.getUint32(record) === 0x6e616d65) nameOffset = view.getUint32(record + 8);
    }
    if (nameOffset < 0) return null;
    const count = view.getUint16(nameOffset + 2);
    const stringsAt = nameOffset + view.getUint16(nameOffset + 4);
    const found = new Map<number, { score: number; value: string }>();
    for (let index = 0; index < count; index += 1) {
      const record = nameOffset + 6 + index * 12;
      const platform = view.getUint16(record);
      const encoding = view.getUint16(record + 2);
      const language = view.getUint16(record + 4);
      const nameId = view.getUint16(record + 6);
      if (nameId !== 1 && nameId !== 4 && nameId !== 16) continue;
      const length = view.getUint16(record + 8);
      const start = stringsAt + view.getUint16(record + 10);
      let value: string;
      let score: number;
      if (platform === 3 || platform === 0) {
        const units: number[] = [];
        for (let offset = 0; offset + 1 < length; offset += 2) units.push(view.getUint16(start + offset));
        value = String.fromCharCode(...units);
        // Windows English (0x0409) first, then any Unicode name.
        score = platform === 3 && language === 0x0409 ? 3 : 2;
      } else if (platform === 1 && encoding === 0) {
        value = String.fromCharCode(...new Uint8Array(bytes, start, length));
        score = language === 0 ? 1 : 0;
      } else {
        continue;
      }
      value = value.replace(/\0/g, "").trim();
      const current = found.get(nameId);
      if (value && (!current || score > current.score)) found.set(nameId, { score, value });
    }
    // 16 is the typographic family ("Inter" for "Inter Bold"); 1 the legacy one.
    const family = found.get(16)?.value ?? found.get(1)?.value;
    if (!family) return null;
    return { family, fullName: found.get(4)?.value ?? null };
  } catch {
    return null;
  }
}
