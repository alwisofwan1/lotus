import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The dither is used through its ready tokens — `--ds-dither-rule` (a dotted rule that fades out
 * to the right) and `--ds-dither-fill` (the active-row fill), or the shell's `--ws-` aliases of
 * them — never through the raw `--ds-dither-mask` with its sizes spelled out again at each site.
 * Those sizes had been copied 23 times across three files; one place to change them is the point.
 *
 * The tokens live on :root in design-system.css because some menus are portalled outside the
 * shell and wear the dither too.
 */

const ROOT = process.cwd();
const OWNER = "src/styles/design-system.css";

function stylesheets(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
    .map((entry) => `${entry.parentPath ?? dir}/${entry.name}`.replace(`${ROOT}/`, ""));
}

describe("dither tokens", () => {
  it("keeps the raw mask inside the token declarations", () => {
    const owner = readFileSync(resolve(ROOT, OWNER), "utf8");
    const lines = owner.split("\n").filter((line) => line.includes("--ds-dither-mask"));
    expect(lines.map((line) => line.trim().split(":")[0])).toEqual([
      "--ds-dither-mask",
      "--ds-dither-rule",
      "--ds-dither-fill",
    ]);
  });

  it("is not read raw by any other stylesheet", () => {
    const offenders = stylesheets("src")
      .filter((file) => !file.endsWith("styles/design-system.css"))
      .filter((file) => /--(ds|ws)-dither-mask/.test(readFileSync(resolve(ROOT, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("gives the shell its tokens as aliases of the root ones", () => {
    const shell = readFileSync(resolve(ROOT, "src/styles/workspace-shell.css"), "utf8");
    expect(shell).toContain("--ws-dither-rule: var(--ds-dither-rule);");
    expect(shell).toContain("--ws-dither-fill: var(--ds-dither-fill);");
  });
});
