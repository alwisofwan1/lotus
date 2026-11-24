import { describe, expect, it, vi } from "vitest";
import { createContextBusRegistry } from "../context-bus-registry";
import { buildArtifact, type ContextArtifact } from "../context-bus-record";

const art = (busNodeId: string, key: string, value: string, version = 1): ContextArtifact =>
  buildArtifact({ projectId: "p", busNodeId, key, value, producer: key, graphRunId: null, now: 1, version });

describe("context-bus-registry", () => {
  it("publishes artifacts per bus node and lists them", () => {
    const reg = createContextBusRegistry();
    reg.publish(art("bus-1", "A", "x"));
    reg.publish(art("bus-1", "B", "y"));
    reg.publish(art("bus-2", "A", "z"));
    expect(reg.list("bus-1").map((a) => a.key)).toEqual(["A", "B"]);
    expect(reg.list("bus-2").map((a) => a.value)).toEqual(["z"]);
    expect(reg.list("missing")).toEqual([]);
  });

  it("overwrites an artifact with the same (bus, key), keeping one entry", () => {
    const reg = createContextBusRegistry();
    reg.publish(art("bus-1", "A", "old", 1));
    reg.publish(art("bus-1", "A", "new", 2));
    const list = reg.list("bus-1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ value: "new", version: 2 });
  });

  it("notifies subscribers of a bus when its artifacts change", () => {
    const reg = createContextBusRegistry();
    const listener = vi.fn();
    const unsub = reg.subscribe("bus-1", listener);
    reg.publish(art("bus-1", "A", "x"));
    expect(listener).toHaveBeenCalledTimes(1);
    reg.publish(art("bus-2", "A", "x")); // other bus → no notify
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    reg.publish(art("bus-1", "B", "y"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hydrates from a durable list and prunes buses not in the keep set", () => {
    const reg = createContextBusRegistry();
    reg.hydrate([art("bus-1", "A", "x"), art("bus-1", "B", "y"), art("bus-2", "A", "z")]);
    expect(reg.list("bus-1")).toHaveLength(2);
    reg.prune(["bus-1"]);
    expect(reg.list("bus-2")).toEqual([]);
    expect(reg.list("bus-1")).toHaveLength(2);
  });

  it("reads the latest artifact for a (bus, key) via get", () => {
    const reg = createContextBusRegistry();
    reg.publish(art("bus-1", "A", "x"));
    expect(reg.get("bus-1", "A")?.value).toBe("x");
    expect(reg.get("bus-1", "missing")).toBeUndefined();
  });
});
