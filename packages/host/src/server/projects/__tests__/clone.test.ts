import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CloneTargetExistsError, InvalidCloneTargetError, ProjectCloner } from "../clone.js";
import type { Git } from "../../../core/git.js";

/**
 * A `git` that records what it was asked and creates the directory a real clone would.
 * `fail` makes it answer like a clone that could not read from the remote.
 */
function fakeGit(opts: { fail?: string } = {}): Git & { calls: Array<{ cwd: string; args: string[] }> } {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const git = (async (cwd: string, args: string[]) => {
    calls.push({ cwd, args });
    if (args[0] !== "clone") return { code: 0, stdout: "", stderr: "" };
    // git writes why a clone failed to stderr, which is the whole reason the port carries it.
    if (opts.fail !== undefined) return { code: 128, stdout: "", stderr: opts.fail };
    mkdirSync(join(cwd, args[args.length - 1]!), { recursive: true });
    return { code: 0, stdout: "", stderr: "" };
  }) as Git & { calls: typeof calls };
  git.calls = calls;
  return git;
}

describe("ProjectCloner", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "clone-root-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("derives the folder name from the repository URL and lands it in the workspace root", async () => {
    const git = fakeGit();
    const cloner = new ProjectCloner({ git, root });

    const job = cloner.start({ url: "https://github.com/alwi/tkt-worker.git" });
    await cloner.settled(job.taskId);

    expect(cloner.get(job.taskId)).toMatchObject({ state: "done", name: "tkt-worker" });
    expect(existsSync(join(root, "tkt-worker"))).toBe(true);
  });

  it("leaves nothing behind when the clone fails, and carries git's own words", async () => {
    // The screen says NOTHING WAS WRITTEN. That sentence is only allowed to exist if a
    // half-finished directory cannot survive a failure.
    const git = fakeGit({ fail: "fatal: could not read from remote repository." });
    const cloner = new ProjectCloner({ git, root });

    const job = cloner.start({ url: "https://github.com/alwi/nope.git" });
    await cloner.settled(job.taskId);

    expect(cloner.get(job.taskId)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("could not read from remote repository"),
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    ["a name with a separator", "sub/dir"],
    ["the current directory", "."],
    ["the parent directory", ".."],
    ["a dotfile the registry scan would skip", ".hidden"],
  ])("refuses %s before any git runs", (_case, name) => {
    const git = fakeGit();
    const cloner = new ProjectCloner({ git, root });

    expect(() => cloner.start({ url: "https://github.com/alwi/x.git", name })).toThrow(
      InvalidCloneTargetError,
    );
    expect(git.calls).toEqual([]);
  });

  it("treats an empty name as nothing chosen, not as an invalid name", async () => {
    // The same reading `cell-routes.ts` already applies to `runnerId` and `model`: an empty
    // string is a field the operator left alone, so the derived name stands.
    const cloner = new ProjectCloner({ git: fakeGit(), root });

    const job = cloner.start({ url: "https://github.com/alwi/tkt-worker.git", name: "" });
    await cloner.settled(job.taskId);

    expect(cloner.get(job.taskId)).toMatchObject({ state: "done", name: "tkt-worker" });
  });

  it("refuses a destination that already exists", () => {
    mkdirSync(join(root, "taken"));
    const cloner = new ProjectCloner({ git: fakeGit(), root });

    expect(() => cloner.start({ url: "https://github.com/alwi/taken.git" })).toThrow(
      CloneTargetExistsError,
    );
  });

  it("passes the chosen branch to git, and omits the flag when none was chosen", async () => {
    const picked = fakeGit();
    const cloner = new ProjectCloner({ git: picked, root });
    await cloner.settled(cloner.start({ url: "u", name: "a", branch: "feat/payments" }).taskId);

    const plain = fakeGit();
    const other = new ProjectCloner({ git: plain, root });
    await other.settled(other.start({ url: "u", name: "b" }).taskId);

    expect(picked.calls[0]!.args).toEqual(
      expect.arrayContaining(["--branch", "feat/payments"]),
    );
    expect(plain.calls[0]!.args).not.toContain("--branch");
  });

  it("adds what this host knows about gh auth, only when the clone failed", async () => {
    // The phone cannot tell a typo from a private repo from an unauthenticated gh, and
    // guessing sends the operator the wrong way. So the host adds the one fact it has.
    const failing = new ProjectCloner({
      git: fakeGit({ fail: "fatal: repository not found" }),
      root,
      ghAuth: async () => "not logged in",
    });
    const job = failing.start({ url: "https://github.com/alwi/private.git" });
    await failing.settled(job.taskId);

    expect(failing.get(job.taskId)!.error).toContain("repository not found");
    expect(failing.get(job.taskId)!.error).toContain("not logged in");

    let asked = false;
    const ok = new ProjectCloner({
      git: fakeGit(), root,
      ghAuth: async () => { asked = true; return "logged in"; },
    });
    await ok.settled(ok.start({ url: "https://github.com/alwi/fine.git" }).taskId);
    expect(asked).toBe(false);
  });
});
