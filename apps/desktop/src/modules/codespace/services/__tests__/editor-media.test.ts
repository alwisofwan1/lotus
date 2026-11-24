import { describe, expect, it } from "vitest";
import { editorMediaType, fitZoom, formatByteSize, readFontNames, stepZoom } from "@/modules/codespace/services/editor-media";

describe("editorMediaType", () => {
  it("knows images, video and audio by extension, in any letter case", () => {
    expect(editorMediaType("/r/fold.png")).toMatchObject({ kind: "image", mime: "image/png", label: "PNG Image" });
    expect(editorMediaType("/r/Photo.JPEG")).toMatchObject({ kind: "image", mime: "image/jpeg" });
    expect(editorMediaType("/r/clip.mov")).toMatchObject({ kind: "video" });
    expect(editorMediaType("C:\\r\\voice.m4a")).toMatchObject({ kind: "audio" });
  });

  it("knows PDF and fonts", () => {
    expect(editorMediaType("/r/Spec.PDF")).toMatchObject({ kind: "pdf", mime: "application/pdf" });
    expect(editorMediaType("/r/Inter.woff2")).toMatchObject({ kind: "font", mime: "font/woff2" });
    expect(editorMediaType("/r/a.ttf")).toMatchObject({ kind: "font", label: "TrueType Font" });
    expect(editorMediaType("/r/a.otf")).toMatchObject({ kind: "font" });
  });

  it("marks SVG as text, so it opens in the editor with the viewer as its preview", () => {
    expect(editorMediaType("/r/icon.svg")).toMatchObject({ kind: "image", textual: true });
  });

  it("is null for code, dotfiles and no file", () => {
    expect(editorMediaType("/r/main.ts")).toBeNull();
    expect(editorMediaType("/r/.png")).toBeNull();
    expect(editorMediaType(null)).toBeNull();
  });
});

describe("zoom", () => {
  it("fits a large image into the viewport but never blows a small one up", () => {
    expect(fitZoom({ width: 2000, height: 1000 }, { width: 1000, height: 1000 })).toBe(0.5);
    expect(fitZoom({ width: 16, height: 16 }, { width: 1000, height: 800 })).toBe(1);
    expect(fitZoom({ width: 0, height: 0 }, { width: 1000, height: 800 })).toBe(1);
  });

  it("steps to the next zoom level, also from a level between steps", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(0.9, -1)).toBe(0.75);
    expect(stepZoom(32, 1)).toBe(32);
    expect(stepZoom(0.05, -1)).toBe(0.05);
  });
});

describe("formatByteSize", () => {
  it("uses decimal units, as Finder does", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1_400_000)).toBe("1.4 MB");
    expect(formatByteSize(250_000)).toBe("250 KB");
  });
});

/** A font file with only a `name` table: the records given, as UTF-16 (platform 3) or Mac Roman (1). */
function fontWithNames(records: Array<{ platform: 1 | 3; language: number; nameId: number; value: string }>, tag = 0x00010000): ArrayBuffer {
  const strings = records.map((record) => record.platform === 3
    ? new Uint8Array([...record.value].flatMap((char) => [0, char.charCodeAt(0)]))
    : new Uint8Array([...record.value].map((char) => char.charCodeAt(0))));
  const nameOffset = 12 + 16;
  const stringsAt = 6 + records.length * 12;
  const size = nameOffset + stringsAt + strings.reduce((total, bytes) => total + bytes.length, 0);
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint32(0, tag);
  view.setUint16(4, 1);
  view.setUint32(12, 0x6e616d65);
  view.setUint32(12 + 8, nameOffset);
  view.setUint16(nameOffset + 2, records.length);
  view.setUint16(nameOffset + 4, stringsAt);
  let offset = 0;
  records.forEach((record, index) => {
    const at = nameOffset + 6 + index * 12;
    view.setUint16(at, record.platform);
    view.setUint16(at + 2, record.platform === 3 ? 1 : 0);
    view.setUint16(at + 4, record.language);
    view.setUint16(at + 6, record.nameId);
    view.setUint16(at + 8, strings[index].length);
    view.setUint16(at + 10, offset);
    new Uint8Array(buffer, nameOffset + stringsAt + offset, strings[index].length).set(strings[index]);
    offset += strings[index].length;
  });
  return buffer;
}

describe("readFontNames", () => {
  it("reads the family and full name, Windows English first", () => {
    const font = fontWithNames([
      { platform: 1, language: 0, nameId: 1, value: "Mac Family" },
      { platform: 3, language: 0x0409, nameId: 1, value: "Inter" },
      { platform: 3, language: 0x0409, nameId: 4, value: "Inter Bold" },
    ]);
    expect(readFontNames(font)).toEqual({ family: "Inter", fullName: "Inter Bold" });
  });

  it("prefers the typographic family, and reads an OpenType (CFF) font", () => {
    const font = fontWithNames([
      { platform: 3, language: 0x0409, nameId: 1, value: "Inter Semi" },
      { platform: 3, language: 0x0409, nameId: 16, value: "Inter" },
    ], 0x4f54544f);
    expect(readFontNames(font)).toEqual({ family: "Inter", fullName: null });
  });

  it("is null for WOFF, damaged files and fonts with no names", () => {
    expect(readFontNames(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]).buffer)).toBeNull();
    expect(readFontNames(new ArrayBuffer(3))).toBeNull();
    expect(readFontNames(fontWithNames([]))).toBeNull();
  });
});
