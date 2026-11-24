import { execFile } from "node:child_process";

/**
 * One line about whether `gh` on this machine is authenticated.
 *
 * Read only when a clone has already failed: a phone cannot tell a typo from a private repo
 * from an unauthenticated CLI, and this is the one fact the host can add without guessing.
 */
export function ghAuthStatus(): Promise<string> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "status"], { encoding: "utf8" }, (err, stdout, stderr) => {
      // `gh` prints the hostname on its own first line, then the verdict indented under it —
      // so the first line is never the answer. Measured 2026-09-11, when a real failure came
      // back reading `gh auth status → github.com`, which tells an operator nothing.
      const said = `${stdout}\n${stderr}`;
      const verdict = verdictLine(said);
      if (verdict !== "") return resolve(verdict);
      resolve(err ? "not logged in" : "logged in");
    });
  });
}

/** The one line that actually says whether this machine can reach GitHub. */
export function verdictLine(text: string): string {
  const said = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /logged in|not logged|authentication/i.test(line));
  // The tick and cross are decoration in a terminal and noise in a phone's error box.
  return (said ?? "").replace(/^[✓✗xX-]\s*/u, "").trim();
}
