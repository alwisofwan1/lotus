import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architecture guard for the Voice Core (ADR-0053, plans/voice-core story 52).
 *
 * Every mode reuses the Voice Core, so the core must never reach back into a mode. TypeScript
 * accepts such an import happily — only this scan stops it. Covers source AND tests: a test that
 * imports a mode module drags that mode into the core's test graph just the same.
 */

const CORE_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.resolve(CORE_DIR, "..", "..");

/** Mode modules the core may not import (via `@/modules/<mode>` or a relative path into them). */
const FORBIDDEN_MODES = ["codecanvas", "codespace", "codechat", "workspace-shell"] as const;

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*)["'`]([^"'`]+)["'`]/g;

/** Mode module a specifier resolves into, or null. `fromFile` anchors relative specifiers. */
function forbiddenModeOf(specifier: string, fromFile: string): string | null {
  let modulePath: string | null = null;
  if (specifier.startsWith("@/")) {
    modulePath = path.resolve(SRC_DIR, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    modulePath = path.resolve(path.dirname(fromFile), specifier);
  }
  if (!modulePath) return null;
  const rel = path.relative(path.join(SRC_DIR, "modules"), modulePath).split(path.sep);
  if (rel[0] === ".." || rel.length === 0) return null;
  return (FORBIDDEN_MODES as readonly string[]).includes(rel[0]) ? rel[0] : null;
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) collectFiles(abs, out);
    else if (/\.[cm]?tsx?$/.test(entry)) out.push(abs);
  }
  return out;
}

function findOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of collectFiles(CORE_DIR)) {
    if (file === __filename) continue;
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER_RE)) {
      const mode = forbiddenModeOf(match[1], file);
      if (mode) offenders.push(`${path.relative(CORE_DIR, file)} → ${match[1]}`);
    }
  }
  return offenders.sort();
}

describe("Voice Core architecture", () => {
  it("contains the mode-neutral voice pieces", () => {
    const files = collectFiles(CORE_DIR).map((f) => path.basename(f));
    for (const piece of [
      "use-speech-to-text.ts",
      "streaming-stt-provider.ts",
      "cloud-tts-provider.ts",
      "use-voice-feedback.ts",
      "s2s-session.ts",
      "speech-gate.ts",
      "tauri-voice-port.ts",
    ]) {
      expect(files).toContain(piece);
    }
  });

  it("never imports a mode module", () => {
    expect(
      findOffenders(),
      "Voice Core file(s) import a mode module. The core is shared by every mode; move the " +
        "mode-specific part into that mode's Voice Adapter instead.",
    ).toEqual([]);
  });

  it("reaches Tauri only through the Tauri Voice Port (type-only imports are fine)", () => {
    const offenders = collectFiles(CORE_DIR)
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter((file) => path.basename(file) !== "tauri-voice-port.ts")
      .filter((file) =>
        /^\s*import\s+(?!type\b)[^;]*?from\s*["']@\/lib\/tauri-api["']/m.test(readFileSync(file, "utf8")) ||
        /import\(\s*["']@\/lib\/tauri-api["']\s*\)/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(CORE_DIR, file));
    expect(offenders, "call Tauri through TauriVoicePort, not @/lib/tauri-api").toEqual([]);
  });

  it("detects alias and relative imports into a mode", () => {
    const file = path.join(CORE_DIR, "x.ts");
    expect(forbiddenModeOf("@/modules/codecanvas/services/voice/x", file)).toBe("codecanvas");
    expect(forbiddenModeOf("@/modules/workspace-shell", file)).toBe("workspace-shell");
    expect(forbiddenModeOf("../codechat/thing", file)).toBe("codechat");
    expect(forbiddenModeOf("../../codespace/a", path.join(CORE_DIR, "sub", "y.ts"))).toBe(
      "codespace",
    );
    expect(forbiddenModeOf("@/lib/tauri-api", file)).toBeNull();
    expect(forbiddenModeOf("./stt-provider", file)).toBeNull();
    expect(forbiddenModeOf("react", file)).toBeNull();
  });
});
