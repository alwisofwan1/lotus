import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

/** What `tauri dev --config` does: RFC 7396 merge patch of the dev file over tauri.conf.json. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const base = typeof target === "object" && target !== null && !Array.isArray(target) ? target : {};
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

type TauriConfig = {
  productName: string;
  identifier: string;
  build?: Record<string, unknown>;
  app?: { windows?: Array<Record<string, unknown>>; security?: Record<string, unknown> };
  bundle?: Record<string, unknown>;
};

describe("Tauri dev profile isolation", () => {
  it("runs tauri dev with a dedicated dev profile config", () => {
    const packageJson = readJson<{ scripts: Record<string, string> }>("package.json");

    expect(packageJson.scripts["tauri:dev"]).toContain("tauri dev --config src-tauri/tauri.dev.conf.json");
  });

  it("uses a distinct bundle identity and visible app title for Lotus Dev", () => {
    const releaseConfig = readJson<TauriConfig>("src-tauri/tauri.conf.json");
    const devConfig = readJson<TauriConfig>("src-tauri/tauri.dev.conf.json");

    expect(releaseConfig.identifier).toBe("com.lotus.desktop");
    expect(releaseConfig.productName).toBe("Lotus");
    expect(devConfig.identifier).toBe("com.lotus.desktop.dev");
    expect(devConfig.productName).toBe("Lotus Dev");
    expect(devConfig.app?.windows?.[0]?.title).toBe("Lotus Dev");
  });

  it("keeps release and dev desktop capabilities equivalent except identity labels", () => {
    const releaseConfig = readJson<TauriConfig>("src-tauri/tauri.conf.json");
    const devConfig = mergePatch(releaseConfig, readJson("src-tauri/tauri.dev.conf.json")) as TauriConfig;

    expect(devConfig.build).toEqual(releaseConfig.build);
    expect(devConfig.app?.security).toEqual(releaseConfig.app?.security);
    expect(devConfig.bundle?.targets).toEqual(releaseConfig.bundle?.targets);
    expect(devConfig.bundle?.icon).toEqual(releaseConfig.bundle?.icon);
    expect(devConfig.bundle?.macOS).toEqual(releaseConfig.bundle?.macOS);
  });
});
