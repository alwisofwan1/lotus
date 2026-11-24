import { describe, expect, it, vi } from "vitest";
import { canvasImagesToNoteAssetMarkdown, dataUrlToNoteAssetUri, extractNoteAssetIds, extractNoteAssetRefs, imageFileToNoteAssetUri, imagePathToNoteAssetUri, noteAssetUri, parseNoteAssetUri, resolveNoteAssetImageRefs } from "../note-assets";

vi.mock("@/lib/tauri/codecanvas", () => ({
  codecanvasSaveNoteAsset: vi.fn(async () => ({ id: "asset_saved" })),
  codecanvasImportNoteAssetPath: vi.fn(async () => ({ id: "asset_imported" })),
  codecanvasReadNoteAsset: vi.fn(async (assetId: string) => {
    if (assetId === "missing") throw new Error("not found");
    return {
      asset: { id: assetId, originalName: `${assetId}.png`, mime: "image/png" },
      base64: `bytes-${assetId}`,
    };
  }),
}));

describe("Note Asset Markdown references", () => {
  it("builds, parses, and extracts Lotus Note Asset URIs", () => {
    expect(noteAssetUri("asset_123")).toBe("lotus-note-asset://asset_123");
    expect(parseNoteAssetUri("lotus-note-asset://asset_123")).toBe("asset_123");
    expect(parseNoteAssetUri("https://example.com/a.png")).toBeNull();
    expect(extractNoteAssetIds("![a](lotus-note-asset://one)\n![b](https://x/y.png)\n![c](lotus-note-asset://two)")).toEqual(["one", "two"]);
    expect(extractNoteAssetRefs("![diagram](lotus-note-asset://one)\n![duplicate](lotus-note-asset://one)")).toEqual([{ id: "one", alt: "diagram" }]);
  });

  it("saves image files and HTML data images as Note Asset URIs", async () => {
    const uri = await imageFileToNoteAssetUri("cp_1", new File(["hi"], "shot.png", { type: "image/png" }));
    expect(uri).toBe("lotus-note-asset://asset_saved");
    await expect(dataUrlToNoteAssetUri("cp_1", "data:image/png;base64,QUJD", "paste.png")).resolves.toBe("lotus-note-asset://asset_saved");
    await expect(dataUrlToNoteAssetUri("cp_1", "data:text/html;base64,PGgxPg==", "bad.html")).resolves.toBeNull();
    await expect(imagePathToNoteAssetUri("cp_1", "/tmp/import.png")).resolves.toBe("lotus-note-asset://asset_imported");
  });

  it("converts canvas drop images into durable Note Asset Markdown", async () => {
    await expect(canvasImagesToNoteAssetMarkdown("cp_1", [
      { kind: "path", path: "/tmp/Design [draft].png" },
      { kind: "bytes", name: "paste.png", mime: "image/png", base64: "QUJD" },
    ])).resolves.toBe("![Design draft](lotus-note-asset://asset_imported)\n\n![paste](lotus-note-asset://asset_saved)");
  });

  it("resolves Note Assets to run image refs and skips duplicate or unavailable ids", async () => {
    await expect(resolveNoteAssetImageRefs(["asset_1", "asset_1", "missing", "asset_2"])).resolves.toEqual([
      { kind: "bytes", name: "asset_1.png", mime: "image/png", base64: "bytes-asset_1" },
      { kind: "bytes", name: "asset_2.png", mime: "image/png", base64: "bytes-asset_2" },
    ]);
  });
});
