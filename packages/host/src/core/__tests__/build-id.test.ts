import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILD_ID } from "../build-id.js";

/// The build id has to survive an actual build.
///
/// The first cut of this used `process.env["LOTUS_BUILD_ID"]` and a test that only read
/// `package.json` for the words `--define`. It passed, and the built binary still contained
/// the lookup: Bun matches the define expression **textually**, and a bracket access is not
/// the expression it was given. Every artefact would have reported `dev` — invisible exactly
/// where this whole issue lives, on a machine nobody is watching.
///
/// So this runs the substitution instead of reading about it. Issue 20 of
/// `plans/pocket-without-laptop`.
describe("the build id survives a real build", () => {
  const root = join(import.meta.dirname, "../../..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  /** The expression `--define` is given, lifted out of the real script rather than retyped. */
  const defineToken = (script: string): string => {
    const m = /--define (\S+?)=/.exec(pkg.scripts[script] ?? "");
    return m?.[1] ?? "";
  };

  it("bakes the id in, proved by building something tiny with the same flag", () => {
    const token = defineToken("build:vps");
    expect(token, "build:vps no longer passes --define").not.toBe("");

    const dir = mkdtempSync(join(tmpdir(), "build-id-"));
    const entry = join(dir, "probe.ts");
    // The same shape `build-id.ts` uses. If that file's shape and this one ever diverge, the
    // next assertion is what notices.
    writeFileSync(entry, readFileSync(join(root, "src/core/build-id.ts"), "utf8") +
      "\nconsole.log(BUILD_ID);\n");

    const out = execFileSync("bun", ["build", entry, `--define`, `${token}="probe-42"`], {
      encoding: "utf8",
    });

    expect(out).toContain("probe-42");
    expect(out, "the lookup survived, so nothing was substituted").not.toContain(token);
  });

  for (const script of ["build:vps", "build:bundle"]) {
    it(`\`${script}\` passes a define at all`, () => {
      expect(pkg.scripts[script] ?? "", `${script} is missing`).toContain("--define ");
    });
  }

  it("says `dev` from source rather than empty or undefined", () => {
    // A blank id reads as a bug in the reporting; `dev` reads as the truth it is.
    expect(BUILD_ID).toBe("dev");
  });
});
