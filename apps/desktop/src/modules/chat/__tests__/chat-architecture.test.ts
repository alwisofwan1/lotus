import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architecture guard for the new Chat module (plans/chat-runtime/PLAN.md).
 *
 * `domain/` is the provider-neutral core: no React, no Tauri, no provider SDK, and no reach into
 * `providers/` or the UI. Provider names may not appear in its string literals either — a
 * `"claude"` check in the domain is a provider leak. `providers/<name>/` translate into the
 * domain; nothing in the domain knows they exist. The new module never imports the old codechat.
 */

const CHAT_DIR = path.resolve(__dirname, "..");
const DOMAIN_DIR = path.join(CHAT_DIR, "domain");
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*)["'`]([^"'`]+)["'`]/g;
const PROVIDER_LITERAL_RE = /["'`][^"'`\n]*\b(claude|codex|anthropic|openai)\b[^"'`\n]*["'`]/i;

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) collectFiles(abs, out);
    else if (/\.[cm]?tsx?$/.test(entry)) out.push(abs);
  }
  return out;
}

function specifiers(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(SPECIFIER_RE)].map((m) => m[1]);
}

function resolvesInto(specifier: string, fromFile: string, target: string): boolean {
  const abs = specifier.startsWith("@/")
    ? path.resolve(CHAT_DIR, "../../..", "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;
  return abs !== null && (abs === target || abs.startsWith(`${target}${path.sep}`));
}

describe("Chat module architecture", () => {
  it("keeps the domain free of React, Tauri, provider SDKs, providers and UI", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(DOMAIN_DIR)) {
      for (const spec of specifiers(file)) {
        const bad =
          /^(react|react-dom|@tauri-apps\/|@anthropic-ai\/|@ai-sdk\/|ai$)/.test(spec) ||
          resolvesInto(spec, file, path.join(CHAT_DIR, "providers")) ||
          resolvesInto(spec, file, path.join(CHAT_DIR, "ui"));
        if (bad) offenders.push(`${path.relative(CHAT_DIR, file)} → ${spec}`);
      }
    }
    expect(offenders, "The chat domain must stay provider- and UI-neutral.").toEqual([]);
  });

  it("names no provider in domain string literals", () => {
    const offenders = collectFiles(DOMAIN_DIR)
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => !line.trim().startsWith("//") && PROVIDER_LITERAL_RE.test(line))
          .map((line) => `${path.relative(CHAT_DIR, file)}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it("never imports the old codechat module", () => {
    const codechat = path.resolve(CHAT_DIR, "..", "codechat");
    const offenders = collectFiles(CHAT_DIR).flatMap((file) =>
      specifiers(file)
        .filter((spec) => resolvesInto(spec, file, codechat))
        .map((spec) => `${path.relative(CHAT_DIR, file)} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});
