import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexModelsCache, resolveCodexModel, CodexModelCatalog } from "../codex-models.js";

// Trimmed real fixture from `~/.codex/models_cache.json` (codex-cli 0.139).
const CACHE = JSON.stringify({
  fetched_at: "2026-06-21T00:00:00Z",
  models: [
    { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list", priority: 16 },
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 9 },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
    { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "list", priority: 23 },
  ],
});

describe("parseCodexModelsCache", () => {
  it("returns only visibility=list models, sorted by priority ascending", () => {
    const models = parseCodexModelsCache(CACHE);
    expect(models.map((m) => m.slug)).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
    expect(models[0]).toEqual({ slug: "gpt-5.5", displayName: "GPT-5.5" });
  });

  it("excludes hidden models (the internal codex-auto-review entry)", () => {
    expect(parseCodexModelsCache(CACHE).some((m) => m.slug === "codex-auto-review")).toBe(false);
  });

  it("falls back to the slug as display name when display_name is missing", () => {
    const raw = JSON.stringify({ models: [{ slug: "gpt-x", visibility: "list", priority: 1 }] });
    expect(parseCodexModelsCache(raw)[0]).toEqual({ slug: "gpt-x", displayName: "gpt-x" });
  });

  it("returns [] for malformed or empty input rather than throwing", () => {
    expect(parseCodexModelsCache("not json")).toEqual([]);
    expect(parseCodexModelsCache(JSON.stringify({}))).toEqual([]);
    expect(parseCodexModelsCache(JSON.stringify({ models: "nope" }))).toEqual([]);
  });
});

describe("resolveCodexModel", () => {
  const models = [
    { slug: "gpt-5.5", displayName: "GPT-5.5" },
    { slug: "gpt-5.4", displayName: "GPT-5.4" },
  ];

  it("keeps the user's selection when it is still a listed model", () => {
    expect(resolveCodexModel(models, "gpt-5.4")).toBe("gpt-5.4");
  });

  it("defaults to the top (highest-priority) model when nothing is selected", () => {
    expect(resolveCodexModel(models, undefined)).toBe("gpt-5.5");
  });

  it("ignores a stale selection no longer offered by the account and uses the top model", () => {
    expect(resolveCodexModel(models, "gpt-5.3-codex")).toBe("gpt-5.5");
  });

  it("returns undefined when the catalog is empty (let codex pick its own default)", () => {
    expect(resolveCodexModel([], "anything")).toBeUndefined();
    expect(resolveCodexModel([], undefined)).toBeUndefined();
  });
});

describe("CodexModelCatalog", () => {
  it("reads and parses the cache file at the configured path", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-cat-"));
    const path = join(dir, "models_cache.json");
    writeFileSync(path, CACHE);
    try {
      const catalog = new CodexModelCatalog(path);
      expect(catalog.list().map((m) => m.slug)).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the cache file is absent (codex never logged in on this host)", () => {
    const catalog = new CodexModelCatalog(join(tmpdir(), "does-not-exist-xyz", "models_cache.json"));
    expect(catalog.list()).toEqual([]);
  });
});
