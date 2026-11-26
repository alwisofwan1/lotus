import { describe, expect, it } from "vitest";
import { riskyAsk, withRiskyMessageParams } from "../risky-ask";

describe("riskyAsk", () => {
  it("names what needs a yes, from the words or the model's flag", () => {
    expect(riskyAsk("push ke main")).toBe("push");
    expect(riskyAsk("naikkan ke GitHub")).toBe("deploy or publish");
    expect(riskyAsk("bersihkan folder lama")).toBe("delete something");
    expect(riskyAsk("post it in the slack channel")).toBe("send something");
    expect(riskyAsk("taruh di GitHub", "high")).toBe("do something that leaves this computer or is hard to undo");
  });

  it("leaves a plain dispatch alone", () => {
    expect(riskyAsk("Kirim ke Codex: audit the voice files")).toBeNull();
    expect(riskyAsk("send a message to Kai: write a poem")).toBeNull();
  });
});

describe("riskyAsk under each confirm mode", () => {
  it("always asks for anything that changes something", () => {
    expect(riskyAsk("commit the poem", "none", "always")).toBe("commit");
    expect(riskyAsk("add a test", "local", "always")).toBe("change something");
  });

  it("risky only lets commits and local changes through, but not what the model calls high, and still stops pushes", () => {
    expect(riskyAsk("commit the poem", "none", "auto")).toBeNull();
    expect(riskyAsk("taruh di GitHub", "high", "auto")).toBe("do something that leaves this computer or is hard to undo");
    expect(riskyAsk("add a test", "local", "auto")).toBeNull();
    // An old-style boolean from a stale model fails safe.
    expect(riskyAsk("taruh di GitHub", true, "auto")).not.toBeNull();
    expect(riskyAsk("commit and push to main", "none", "auto")).toBe("push");
    expect(riskyAsk("buat PR untuk ini", "none", "auto")).toBe("change GitHub");
  });

  it("never asks when off", () => {
    expect(riskyAsk("git push --force", "high", "off")).toBeNull();
  });
});

describe("withRiskyMessageParams", () => {
  it("adds risky and confirm to the named tools only", () => {
    const tools = [
      { name: "dispatch", parameters: { type: "object", properties: { task: {} } } },
      { name: "focus", parameters: { type: "object", properties: { target: {} } } },
    ];
    const [dispatch, focus] = withRiskyMessageParams(tools, ["dispatch"]);
    expect(Object.keys((dispatch.parameters as { properties: object }).properties)).toEqual(["task", "risky", "confirm"]);
    expect(focus).toBe(tools[1]);
  });
});
