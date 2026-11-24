import { describe, expect, it } from "vitest";

import { agentSpawnEnv, parentSessionMarkers } from "../agent-env.js";

describe("agentSpawnEnv", () => {
  it("removes every marker that names or reaches the launching session", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", HOME: "/home/op" };
    for (const marker of parentSessionMarkers()) env[marker] = "leaked";

    const clean = agentSpawnEnv(env);

    for (const marker of parentSessionMarkers()) expect(clean).not.toHaveProperty(marker);
    expect(clean["PATH"]).toBe("/bin");
    expect(clean["HOME"]).toBe("/home/op");
  });

  it("keeps the flag Lotus sets on purpose", () => {
    // A prefix sweep would turn off the feature this whole app is a front end for
    // (`launch.rs:239`). That is why the list is explicit.
    const clean = agentSpawnEnv({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" });
    expect(clean["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"]).toBe("1");
  });

  it("does not make a default agent use the host's CCS account", () => {
    const inherited = { CLAUDE_CONFIG_DIR: "/home/op/.ccs/instances/initech" };
    expect(agentSpawnEnv(inherited)).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(inherited.CLAUDE_CONFIG_DIR).toContain("initech");
  });

  it("keeps a profile explicitly chosen for this cell", () => {
    const clean = agentSpawnEnv(
      { CLAUDE_CONFIG_DIR: "/home/op/.ccs/instances/work" },
      { CLAUDE_CONFIG_DIR: "/home/op/.ccs/instances/initech" },
    );
    expect(clean["CLAUDE_CONFIG_DIR"]).toBe("/home/op/.ccs/instances/initech");
  });

  it("adds what the caller names, and lets it win", () => {
    const clean = agentSpawnEnv({ LOTUS_PANE_ID: "old" }, { LOTUS_PANE_ID: "p-1" });
    expect(clean["LOTUS_PANE_ID"]).toBe("p-1");
  });

  it("does not mutate the environment it was given", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_CHILD_SESSION: "1" };
    agentSpawnEnv(env);
    // The host keeps running under its own env; a spawn helper that edited it would take
    // the marker away from the process that legitimately has one.
    expect(env["CLAUDE_CODE_CHILD_SESSION"]).toBe("1");
  });

  it("names the marker that started this: the transcript killer", () => {
    expect(parentSessionMarkers()).toContain("CLAUDE_CODE_CHILD_SESSION");
    // And the one that mattered more.
    expect(parentSessionMarkers()).toContain("CLAUDE_CODE_MESSAGING_TOKEN");
  });
});
