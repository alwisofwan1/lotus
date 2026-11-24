import { describe, it, expect } from "vitest";

import {
  slugify,
  agentBranchName,
  agentWorktreePath,
  uniqueSlug,
} from "../worktree-naming";

describe("slugify (worktree naming)", () => {
  it("lowercases and replaces runs of non-alphanumerics with a single dash", () => {
    expect(slugify("Frontend Specialist")).toBe("frontend-specialist");
    expect(slugify("Auth & Payments!!")).toBe("auth-payments");
  });

  it("trims leading/trailing dashes and collapses repeats", () => {
    expect(slugify("  --Lead Agent--  ")).toBe("lead-agent");
    expect(slugify("a___b///c")).toBe("a-b-c");
  });

  it("falls back to 'agent' when nothing slug-worthy remains", () => {
    expect(slugify("")).toBe("agent");
    expect(slugify("!!!")).toBe("agent");
  });
});

describe("agentBranchName", () => {
  it("composes a lotus/<team>/<agent> branch ref from pre-slugged tokens", () => {
    expect(agentBranchName("checkout-revamp", "frontend")).toBe(
      "lotus/checkout-revamp/frontend",
    );
  });
});

describe("agentWorktreePath", () => {
  it("places worktrees in a .lotus-worktrees dir beside the repo (ADR 0015)", () => {
    expect(agentWorktreePath("/Users/me/checkout", "checkout-revamp", "frontend")).toBe(
      "/Users/me/.lotus-worktrees/checkout-revamp/frontend",
    );
  });

  it("tolerates a trailing slash on the repo path", () => {
    expect(agentWorktreePath("/Users/me/checkout/", "t", "a")).toBe(
      "/Users/me/.lotus-worktrees/t/a",
    );
  });
});

describe("uniqueSlug", () => {
  it("returns the base when it does not collide", () => {
    expect(uniqueSlug("frontend", [])).toBe("frontend");
    expect(uniqueSlug("frontend", ["backend"])).toBe("frontend");
  });

  it("appends the lowest free numeric suffix on collision", () => {
    expect(uniqueSlug("frontend", ["frontend"])).toBe("frontend-2");
    expect(uniqueSlug("frontend", ["frontend", "frontend-2"])).toBe("frontend-3");
  });
});
