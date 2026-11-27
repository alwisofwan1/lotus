import { execFile } from "node:child_process";

/** Return the exit status as data because commands such as git diff can signal differences with a nonzero status. */
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
