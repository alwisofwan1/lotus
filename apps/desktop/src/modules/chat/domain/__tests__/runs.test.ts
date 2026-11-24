import { describe, expect, it } from "vitest";

import { firstFileRef, runKind, runResult, runScope, threadRuns } from "../runs";
import type { ThreadState } from "../thread-state";

describe("runKind", () => {
  it("knows tests, lint, types and builds", () => {
    expect(runKind("bun run test src/a.test.ts")).toBe("tests");
    expect(runKind("cd apps/desktop && npx vitest run")).toBe("tests");
    expect(runKind("cargo test -p lotus")).toBe("tests");
    expect(runKind("pytest -q")).toBe("tests");
    expect(runKind("bun run lint")).toBe("lint");
    expect(runKind("cargo clippy")).toBe("lint");
    expect(runKind("npx tsc --noEmit")).toBe("types");
    expect(runKind("bun run typecheck")).toBe("types");
    expect(runKind("cargo build --release")).toBe("build");
    expect(runKind("npm run build")).toBe("build");
  });

  it("leaves other commands in the steps", () => {
    for (const c of ["ls -la", "git status", "cat test/a.ts", "grep -rn build src", "echo test", `grep -n -E '"(test|vitest)"|vitest' package.json; ls node_modules/.bin`]) {
      expect(runKind(c)).toBeNull();
    }
    expect(runKind('cd apps/desktop && CI=1 bunx vitest run a.test.ts; echo "EXIT=$?"')).toBe("tests");
  });
});

describe("runResult", () => {
  it("reads vitest counts and the failing test", () => {
    const out = [
      "Exit code 1",
      " ✓ src/a.test.ts (18 tests)",
      " FAIL  src/LoginForm.test.tsx > LoginForm > shows the error",
      "AssertionError: expected 'Wrong password' to be 'Invalid'",
      "- Expected",
      "+ Received",
      " ❯ src/LoginForm.test.tsx:31:7",
      "",
      " Tests  1 failed | 18 passed (19)",
    ].join("\n");
    const r = runResult("tests", "failed", out);
    expect(r.summary).toBe("18 passed · 1 failed");
    expect(r.error).toBe("shows the error");
    expect(r.excerpt.slice(0, 3)).toEqual(["AssertionError: expected 'Wrong password' to be 'Invalid'", "- Expected", "+ Received"]);
    expect(r.ref).toBe("src/LoginForm.test.tsx:31");
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toBe(" ✓ src/a.test.ts (18 tests)");
    expect(firstFileRef(r.excerpt)).toBe("src/LoginForm.test.tsx:31");
  });

  it("goes red on a failing count even when the command exited 0", () => {
    const r = runResult("tests", "completed", " × deliberate > adds 2ms\n Tests  1 failed (1)\nEXIT=1");
    expect(r.failed).toBe(true);
    expect(r.error).toBe("adds");
    expect(runResult("types", "completed", "a.ts(3,1): error TS2322: x").failed).toBe(true);
    expect(runResult("lint", "completed", "✖ 1 problem (0 errors, 1 warning)").failed).toBe(false);
  });

  it("sums cargo's per-crate results and reads jest, pytest and flutter", () => {
    const cargo = "test result: ok. 3 passed; 0 failed;\ntest result: FAILED. 4 passed; 1 failed;";
    expect(runResult("tests", "failed", cargo).summary).toBe("7 passed · 1 failed");
    expect(runResult("tests", "completed", "Tests:       19 passed, 19 total").summary).toBe("19 passed");
    expect(runResult("tests", "failed", "==== 2 failed, 5 passed in 0.3s ====").summary).toBe("5 passed · 2 failed");
    expect(runResult("tests", "completed", "00:02 +12: All tests passed!").summary).toBe("12 passed");
  });

  it("reads lint and type counts, and says so when there are none", () => {
    expect(runResult("lint", "failed", "✖ 3 problems (2 errors, 1 warning)").summary).toBe("2 errors · 1 warning");
    expect(runResult("types", "failed", "Found 1 error in a.ts:3").summary).toBe("1 error");
    expect(runResult("types", "failed", "a.ts(3,1): error TS2322: x\nb.ts(1,1): error TS2322: y").summary).toBe("2 errors");
    expect(runResult("lint", "completed", "No issues found!").summary).toBe("No problems");
    expect(runResult("types", "completed", "").summary).toBe("Passed");
  });

  it("falls back to Failed and the first error line when there is nothing to count", () => {
    const r = runResult("build", "failed", "Exit code 2\nCompiling lotus\nerror[E0425]: cannot find value `x`");
    expect(r.summary).toBe("Failed");
    expect(r.error).toBe("error[E0425]: cannot find value `x`");
    expect(runResult("build", "completed", "done").summary).toBe("Built");
    expect(runResult("tests", "running", null).summary).toBe("Running…");
  });
});

describe("threadRuns", () => {
  const command = (id: string, cmd: string, status: "completed" | "failed") => ({
    item: { id, kind: "command" as const, status, command: cmd, description: null, output: null },
    startedAt: Number(id.slice(1)),
    endedAt: null,
  });

  it("lists checks newest first; an older run of the same command is earlier", () => {
    const state = {
      turns: [{ items: [command("c1", "bun run test", "failed"), command("c2", "ls", "completed"), command("c3", "bun run test", "completed")] }],
    } as unknown as ThreadState;
    const runs = threadRuns(state);
    expect(runs.map((r) => [r.id, r.superseded, r.passedLater])).toEqual([
      ["c3", false, false],
      ["c1", true, true],
    ]);
  });
});

describe("runScope", () => {
  it("ignores redirects, pipes and the echo after a check", () => {
    const a = runScope('bunx vitest run src/lib/a.test.ts; echo "EXIT=$?"', "tests");
    expect(a).toBe("src/lib/a.test.ts");
    expect(runScope("cd app && bunx vitest run src/lib/a.test.ts 2>&1 | tail -20", "tests")).toBe(a);
    expect(runScope("bun run test", "tests")).toBe("");
  });

  it("lets a re-run with extra plumbing, or the whole suite, supersede a failure", () => {
    const cmd = (id: string, command: string, status: "completed" | "failed", output: string) => ({
      item: { id, kind: "command" as const, status, command, description: null, output },
      startedAt: 0,
      endedAt: null,
    });
    const state = {
      turns: [
        {
          items: [
            cmd("c1", "bunx vitest run src/a.test.ts", "failed", "Tests  1 failed (1)"),
            cmd("c2", "bunx vitest run src/b.test.ts", "failed", "Tests  1 failed (1)"),
            cmd("c3", 'bunx vitest run src/a.test.ts 2>&1 | tail; echo "EXIT=$?"', "completed", "Tests  1 passed (1)"),
          ],
        },
      ],
    } as unknown as ThreadState;
    expect(threadRuns(state).map((r) => [r.id, r.superseded, r.passedLater])).toEqual([
      ["c3", false, false],
      ["c2", false, false],
      ["c1", true, true],
    ]);
    state.turns[0].items.push(cmd("c4", "bun run test", "completed", "Tests  9 passed (9)") as never);
    expect(threadRuns(state).filter((r) => r.superseded).map((r) => r.id)).toEqual(["c3", "c2", "c1"]);
  });
});
