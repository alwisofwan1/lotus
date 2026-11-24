import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { bindFailureHint, listenOrWarn } from "../bind-diagnosis.js";

describe("bindFailureHint", () => {
  it("names the stale address and where to change it", () => {
    const hint = bindFailureHint("EADDRNOTAVAIL", "10.229.135.108");

    // The errno alone sends the operator to a search engine; this sends them to a
    // dropdown two clicks away.
    expect(hint).toContain("10.229.135.108");
    expect(hint).toContain("not on any interface");
    expect(hint).toContain("Listen on");
  });

  it("points a taken port at the likely culprit", () => {
    expect(bindFailureHint("EADDRINUSE", "127.0.0.1")).toContain("still be holding the port");
  });

  /// Silence rather than a guess: an unclassified errno dressed up as one of the two
  /// above would send the operator to fix something that was never broken.
  it("offers nothing for a failure it cannot name", () => {
    expect(bindFailureHint("EACCES", "127.0.0.1")).toBeUndefined();
    expect(bindFailureHint(undefined, "127.0.0.1")).toBeUndefined();
  });
});

describe("listenOrWarn", () => {
  it("binds a free port, and warns instead of throwing when the port is taken", async () => {
    const first = createServer();
    expect(await listenOrWarn(first, { host: "127.0.0.1", port: 0 }, () => undefined)).toBe(true);
    const port = (first.address() as { port: number }).port;
    const warnings: Array<Record<string, unknown>> = [];
    expect(await listenOrWarn(createServer(), { host: "127.0.0.1", port }, (_e, f) => warnings.push(f))).toBe(false);
    expect(warnings[0]).toMatchObject({ port, code: "EADDRINUSE" });
    first.close();
  });
});
