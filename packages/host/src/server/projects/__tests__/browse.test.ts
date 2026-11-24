import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowseRoots, OutsideRootsError } from "../browse.js";

/**
 * ADR-A: the jail is the design, not a patch behind it.
 *
 * Every refusal here is load-bearing. A paired phone that gets out of these roots is a shell,
 * and the whole reason this route exists is that picking a folder should not become one.
 */
describe("BrowseRoots", () => {
  let dir: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    // Resolved, because every path this class answers with is: macOS makes `/tmp` a symlink
    // to `/private/tmp`, and a jail that compared the *given* string would be the bug this
    // whole class exists to avoid.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "browse-")));
    root = join(dir, "workspaces");
    outside = join(dir, "secrets");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const browse = () => new BrowseRoots([root]);

  it("lists directories and never files", () => {
    mkdirSync(join(root, "a-folder"));
    writeFileSync(join(root, "a-file.txt"), "not yours");

    const page = browse().list(root);

    expect(page.entries.map((e) => e.name)).toEqual(["a-folder"]);
  });

  it("refuses a path in no root at all", () => {
    expect(() => browse().list(outside)).toThrow(OutsideRootsError);
  });

  it("refuses a climb out with ..", () => {
    expect(() => browse().list(join(root, "..", "secrets"))).toThrow(OutsideRootsError);
  });

  it("refuses a symlink that points out of the roots", () => {
    // The cheapest way to make a jail meaningless, and the one a containment check on the
    // *given* string would miss entirely.
    symlinkSync(outside, join(root, "escape"));

    expect(() => browse().list(join(root, "escape"))).toThrow(OutsideRootsError);
  });

  it("has no parent at a root, so there is no way up to draw", () => {
    mkdirSync(join(root, "inner"));

    expect(browse().list(root).parent).toBeNull();
    expect(browse().list(join(root, "inner")).parent).toBe(root);
  });

  it("names a repository and the branch it is on", () => {
    const repo = join(root, "a-repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/payments\n");

    const [entry] = browse().list(root).entries;

    expect(entry).toMatchObject({ name: "a-repo", isRepo: true, branch: "feat/payments" });
  });

  it("still calls a detached or worktree checkout a repository, with no branch to name", () => {
    const repo = join(root, "detached");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "9fceb02d0ae598e95dc970b74767f19372d61af8\n");

    const [entry] = browse().list(root).entries;

    expect(entry).toMatchObject({ isRepo: true, branch: null });
  });

  it("calls a checkout whose HEAD it cannot read a repository anyway", () => {
    // A clone still in flight, or a permission this host does not have. Saying "not a repo"
    // would be a claim about the folder rather than about what this host could see.
    mkdirSync(join(root, "mid-clone", ".git"), { recursive: true });

    expect(browse().list(root).entries[0]).toMatchObject({ isRepo: true, branch: null });
  });

  it("counts what is inside, so a plain folder can say whether it is worth entering", () => {
    const plain = join(root, "notes");
    mkdirSync(join(plain, "one"), { recursive: true });
    mkdirSync(join(plain, "two"), { recursive: true });
    mkdirSync(join(plain, ".hidden"), { recursive: true });

    const [entry] = browse().list(root).entries;

    expect(entry).toMatchObject({ name: "notes", isRepo: false, children: 2 });
  });

  it("says which entries are already projects, so a row need not guess", () => {
    const taken = join(root, "taken");
    const free = join(root, "free");
    mkdirSync(taken);
    mkdirSync(free);

    const page = new BrowseRoots([root], { held: () => [taken] }).list(root);

    expect(page.entries).toMatchObject([
      { name: "free", isProject: false },
      { name: "taken", isProject: true },
    ]);
  });

  it("says the workspace root itself cannot be taken, and why", () => {
    // Its contents are already the projects. The mockup draws a dead button here; it can only
    // be honest about it if the host says so, because the phone cannot know what is scanned.
    const page = new BrowseRoots([root], { scanRoot: root }).list(root);

    expect(page.takeable).toBe(false);
    expect(page.whyNot).toBe("workspace-root");
  });

  it("says a folder already taken cannot be taken again", () => {
    const inner = join(root, "inner");
    mkdirSync(inner);

    const page = new BrowseRoots([root], { held: () => [inner] }).list(inner);

    expect(page.takeable).toBe(false);
    expect(page.whyNot).toBe("already-a-project");
  });

  it("is takeable when it is neither", () => {
    const inner = join(root, "plain");
    mkdirSync(inner);

    const page = browse().list(inner);

    expect(page).toMatchObject({ takeable: true, whyNot: null });
  });

  it("offers every root it was given, so the phone can start somewhere", () => {
    const second = join(dir, "kerja");
    mkdirSync(second);

    expect(new BrowseRoots([root, second]).roots()).toEqual([
      { name: "workspaces", path: root },
      { name: "kerja", path: second },
    ]);
  });

  it("drops a configured root that does not exist, rather than offering a dead end", () => {
    expect(new BrowseRoots([root, join(dir, "never-made")]).roots())
      .toEqual([{ name: "workspaces", path: root }]);
  });
});
