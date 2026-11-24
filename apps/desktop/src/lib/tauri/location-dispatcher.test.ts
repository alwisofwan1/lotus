import { describe, expect, it, vi } from "vitest";
import { createLocationDispatcher } from "./location-dispatcher";
import type { CodeSpaceStoredWorkspaceLocation } from "./codespace";

// ── Stub SSH context type used across all tests ───────────────────────────────

type StubCtx = { host: string; root: string };

const SSH: CodeSpaceStoredWorkspaceLocation = {
  kind: "ssh",
  host: "vps",
  user: "dev",
  port: 22,
  remoteCwd: "/srv/repo",
};

const LOCAL: CodeSpaceStoredWorkspaceLocation = {
  kind: "local",
  cwd: "/Users/dev/repo",
};

// Dispatcher config that mirrors the editor's absolute-path-only override guard
const d = createLocationDispatcher<StubCtx>({
  toSshContext: (location, sshOverride) => {
    if (location?.kind !== "ssh") return null;
    const trimmed = sshOverride?.trim();
    const root = trimmed?.startsWith("/") ? trimmed : (location.remoteCwd ?? "");
    if (!root) return null;
    return { host: location.host, root };
  },
  toLocalRoot: (location, localOverride) =>
    localOverride ?? (location?.kind === "local" ? location.cwd : ""),
});

// ── Tracer bullet ─────────────────────────────────────────────────────────────

describe("createLocationDispatcher — routing", () => {
  it("routes SSH location to sshFn and returns its result", async () => {
    const sshFn = vi.fn().mockResolvedValue("ssh-result");
    const localFn = vi.fn();

    const result = await d.route(
      SSH, undefined, undefined,
      sshFn, localFn,
      { kind: "fallback", value: "fallback" },
    );

    expect(result).toBe("ssh-result");
    expect(sshFn).toHaveBeenCalledWith({ host: "vps", root: "/srv/repo" });
    expect(localFn).not.toHaveBeenCalled();
  });

  it("routes local location to localFn and returns its result", async () => {
    const sshFn = vi.fn();
    const localFn = vi.fn().mockResolvedValue("local-result");

    const result = await d.route(
      LOCAL, undefined, undefined,
      sshFn, localFn,
      { kind: "fallback", value: "fallback" },
    );

    expect(result).toBe("local-result");
    expect(localFn).toHaveBeenCalledWith("/Users/dev/repo");
    expect(sshFn).not.toHaveBeenCalled();
  });

  it("applies absolute sshOverride to SSH context", async () => {
    const sshFn = vi.fn().mockResolvedValue("ok");

    await d.route(SSH, "/override/path", undefined, sshFn, vi.fn(), { kind: "fallback", value: "" });

    expect(sshFn).toHaveBeenCalledWith({ host: "vps", root: "/override/path" });
  });

  it("ignores non-absolute sshOverride — falls back to original remoteCwd", async () => {
    const sshFn = vi.fn().mockResolvedValue("ok");

    await d.route(SSH, "~/relative", undefined, sshFn, vi.fn(), { kind: "fallback", value: "" });

    expect(sshFn).toHaveBeenCalledWith({ host: "vps", root: "/srv/repo" });
  });

  it("applies localOverride as local root", async () => {
    const localFn = vi.fn().mockResolvedValue("ok");

    await d.route(LOCAL, undefined, "/custom/root", vi.fn(), localFn, { kind: "fallback", value: "" });

    expect(localFn).toHaveBeenCalledWith("/custom/root");
  });

  it("uses localOverride as root when location is null", async () => {
    const localFn = vi.fn().mockResolvedValue("ok");

    await d.route(null, undefined, "/fallback", vi.fn(), localFn, { kind: "throw", message: "no root" });

    expect(localFn).toHaveBeenCalledWith("/fallback");
  });
});

// ── No-root behaviour ─────────────────────────────────────────────────────────

describe("createLocationDispatcher — no-root behaviour", () => {
  it("returns fallback value when location is null and no override", async () => {
    const result = await d.route(
      null, undefined, undefined,
      vi.fn(), vi.fn(),
      { kind: "fallback", value: [] as string[] },
    );

    expect(result).toEqual([]);
  });

  it("throws the supplied message when location is null and onNoRoot is throw", async () => {
    await expect(
      d.route(null, undefined, undefined, vi.fn(), vi.fn(), { kind: "throw", message: "needs root" }),
    ).rejects.toThrow("needs root");
  });

  it("returns fallback when local location has empty cwd and no override", async () => {
    const emptyLocal: CodeSpaceStoredWorkspaceLocation = { kind: "local", cwd: "" };

    const result = await d.route(
      emptyLocal, undefined, undefined,
      vi.fn(), vi.fn(),
      { kind: "fallback", value: null },
    );

    expect(result).toBeNull();
  });
});

// ── Context accessors ─────────────────────────────────────────────────────────

describe("createLocationDispatcher — getSshContext / getLocalRoot", () => {
  it("getSshContext returns context for SSH location", () => {
    const ctx = d.getSshContext(SSH, undefined);
    expect(ctx).toEqual({ host: "vps", root: "/srv/repo" });
  });

  it("getSshContext returns null for local location", () => {
    expect(d.getSshContext(LOCAL, undefined)).toBeNull();
  });

  it("getSshContext returns null for null location", () => {
    expect(d.getSshContext(null, undefined)).toBeNull();
  });

  it("getSshContext applies absolute override", () => {
    const ctx = d.getSshContext(SSH, "/new/root");
    expect(ctx?.root).toBe("/new/root");
  });

  it("getLocalRoot returns cwd for local location", () => {
    expect(d.getLocalRoot(LOCAL, undefined)).toBe("/Users/dev/repo");
  });

  it("getLocalRoot returns override when supplied", () => {
    expect(d.getLocalRoot(LOCAL, "/custom")).toBe("/custom");
  });

  it("getLocalRoot returns empty string for SSH location with no override", () => {
    expect(d.getLocalRoot(SSH, undefined)).toBe("");
  });

  it("getLocalRoot returns empty string for null location with no override", () => {
    expect(d.getLocalRoot(null, undefined)).toBe("");
  });
});
