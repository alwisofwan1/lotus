import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

function readJson<T>(relativePath: string): T {
  const fullPath = path.join(repoRoot, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8")) as T;
}

describe("macOS release packaging", () => {
  it("references macOS plist files that exist in src-tauri", () => {
    const tauriConfig = readJson<{ bundle?: { macOS?: { entitlements?: string; infoPlist?: string } } }>("src-tauri/tauri.conf.json");
    const infoPlist = tauriConfig.bundle?.macOS?.infoPlist;
    const entitlements = tauriConfig.bundle?.macOS?.entitlements;

    expect(infoPlist).toBeTruthy();
    expect(entitlements).toBeTruthy();
    expect(fs.existsSync(path.join(repoRoot, "src-tauri", infoPlist!))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "src-tauri", entitlements!))).toBe(true);
  });

  it("builds both the app bundle and dmg installer", () => {
    const tauriConfig = readJson<{ bundle?: { targets?: string[] } }>("src-tauri/tauri.conf.json");

    expect(tauriConfig.bundle?.targets).toEqual(
      expect.arrayContaining(["app", "dmg"]),
    );
  });

  it("does not auto-install into /Applications during release builds", () => {
    const packageJson = readJson<{ scripts?: Record<string, string> }>("package.json");
    const buildScript = packageJson.scripts?.["tauri:build"] ?? "";

    expect(buildScript).not.toContain("/Applications/");
    expect(buildScript).not.toContain("rsync");
  });

  it("runs macOS artifact verification after the convenience install build", () => {
    const packageJson = readJson<{ scripts?: Record<string, string> }>("package.json");
    const buildMacScript = packageJson.scripts?.["tauri:build:mac"] ?? "";

    // The build itself lives in tauri-build-macos.mjs (app-only bundle + its own dmg), which
    // installs with rsync; verification runs only once that succeeds.
    expect(buildMacScript).toMatch(/^bun scripts\/tauri-build-macos\.mjs && bun run tauri:verify:mac$/);
    const buildMacSource = fs.readFileSync(path.join(repoRoot, "scripts/tauri-build-macos.mjs"), "utf8");
    expect(buildMacSource).toContain('run("bun", ["scripts/check-release-env.mjs"])');
    expect(buildMacSource).toContain('run("rsync", ["-a", "--delete"');
  });

  it("uses the generated dmg artifact instead of creating a raw app-only disk image", () => {
    const installScript = fs.readFileSync(
      path.join(repoRoot, "scripts/install.sh"),
      "utf8",
    );

    expect(installScript).not.toContain("-srcfolder \"$APP_PATH\"");
    expect(installScript).not.toContain("hdiutil create");
    expect(installScript).toContain("bundle/dmg");
  });
});
