import { describe, expect, it, vi, beforeEach } from "vitest";

const listClaudeSessions = vi.fn();
const listClaudeSessionsSsh = vi.fn();
const readClaudeSessionTail = vi.fn();
const readClaudeSessionTailSsh = vi.fn();

vi.mock("@/lib/tauri-api", () => ({
  listClaudeSessions: (...args: unknown[]) => listClaudeSessions(...args),
  listClaudeSessionsSsh: (...args: unknown[]) => listClaudeSessionsSsh(...args),
  readClaudeSessionTail: (...args: unknown[]) => readClaudeSessionTail(...args),
  readClaudeSessionTailSsh: (...args: unknown[]) => readClaudeSessionTailSsh(...args),
}));

const { claudeSessionTailFor, claudeSessionsFor } = await import("../remote-sessions");

const SSH = { kind: "ssh" as const, host: "devbox-vps", user: "root" };

describe("reading a runner's transcripts on the right machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listClaudeSessions.mockResolvedValue(["local-1"]);
    listClaudeSessionsSsh.mockResolvedValue(["remote-1"]);
    readClaudeSessionTail.mockResolvedValue("local tail");
    readClaudeSessionTailSsh.mockResolvedValue("remote tail");
  });

  it("reads this disk for a local project", async () => {
    await expect(claudeSessionsFor(null, "/repo")).resolves.toEqual(["local-1"]);
    expect(listClaudeSessionsSsh).not.toHaveBeenCalled();
  });

  it("reads the machine for a remote project", async () => {
    await expect(claudeSessionsFor(SSH, "/srv/api")).resolves.toEqual(["remote-1"]);
    expect(listClaudeSessions).not.toHaveBeenCalled();
    expect(listClaudeSessionsSsh).toHaveBeenCalledWith(
      { host: "devbox-vps", user: "root", port: null },
      "/srv/api",
    );
  });

  it("spells an absent user and port as null, because they round-trip through serde", async () => {
    await claudeSessionsFor({ kind: "ssh", host: "h" }, "/srv");
    expect(listClaudeSessionsSsh).toHaveBeenCalledWith({ host: "h", user: null, port: null }, "/srv");
  });

  it("takes a dormant card's preview from the machine that ran the agent", async () => {
    await expect(claudeSessionTailFor(SSH, "/srv/api", "abc", 120)).resolves.toBe("remote tail");
    expect(readClaudeSessionTailSsh).toHaveBeenCalledWith(
      { host: "devbox-vps", user: "root", port: null },
      "/srv/api",
      "abc",
      120,
    );
    expect(readClaudeSessionTail).not.toHaveBeenCalled();
  });

  it("still reads this disk for a local card", async () => {
    await expect(claudeSessionTailFor(undefined, "/repo", "abc")).resolves.toBe("local tail");
    expect(readClaudeSessionTail).toHaveBeenCalledWith("/repo", "abc", 240);
  });
});
