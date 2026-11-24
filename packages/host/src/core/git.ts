import { execFile } from "node:child_process";

/**
 * Runs `git` in a working tree. Injected so tests never touch a real repository, and so
 * a non-zero exit is data rather than an exception: `git diff` exits 1 when there *is*
 * a difference, which is the answer, not a failure.
 *
 * Lives in `core/` because both `adapters/` and `server/` need it and the layering runs
 * one way — `adapters` → `core`, `server` → `core`, never `server` → `adapters`.
 */
export type Git = (
  cwd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realGit: Git = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
              ? 128
              : 0;
        resolve({
          code,
          stdout: typeof stdout === "string" ? stdout : "",
          // Kept, unlike before: `git clone` says why it failed here and nowhere else, and
          // a phone that cannot see it is left guessing between a typo, a private repo and
          // an unauthenticated `gh`.
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
