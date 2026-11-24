import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-0023: the Agent Runtime Kernel is a shared primitive, not a surface. It must stay
// dependency-free of either UI module so a Live Agent Session (CodeCanvas) and a Swarm Agent
// Panel (Swarm) can both depend on it without re-introducing CodeCanvas↔Swarm coupling.
// This guard fails the build if a future edit reaches back into a surface module.
const KERNEL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
// Match real import/re-export/dynamic-import statements only — not prose in comments
// (the kernel's own docs name these paths to state the invariant).
const FORBIDDEN_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["']@\/modules\/(?:swarm|codecanvas)/g;

function kernelSourceFiles(): string[] {
  return readdirSync(KERNEL_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => join(KERNEL_DIR, name));
}

describe("agent-runtime kernel invariants (ADR-0023)", () => {
  it("never imports from a surface module", () => {
    const offenders: string[] = [];
    for (const file of kernelSourceFiles()) {
      const matches = readFileSync(file, "utf8").match(FORBIDDEN_IMPORT);
      if (matches) offenders.push(`${file} → ${matches.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("actually scans the kernel files (guard is not vacuous)", () => {
    expect(kernelSourceFiles().length).toBeGreaterThanOrEqual(3);
  });
});
