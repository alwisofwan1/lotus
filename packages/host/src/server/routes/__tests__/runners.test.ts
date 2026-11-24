import { describe, expect, it } from "vitest";

import { AgentRunnerRegistry } from "../../agent/registry.js";
import type { AgentRunner } from "../../agent/types.js";
import { listRunnersHandler } from "../runners.js";

/**
 * What a Standalone Host answers for `GET /api/runners`.
 *
 * This route exists because of a gap found by running the thing (2026-09-07): the mobile
 * façade builds `bootstrap.runners[]` from it, a standalone host had no such route, and
 * `orNotSupported` quietly turned the 404 into an empty list. Every per-runner field the
 * phone reads — `headless` above all — therefore never reached a VPS, which is the one
 * deployment those fields were added for.
 */
function runner(providerId: string): AgentRunner {
  return { providerId } as AgentRunner;
}

function registryOf(...ids: string[]): AgentRunnerRegistry {
  const reg = new AgentRunnerRegistry();
  for (const id of ids) reg.register(runner(id));
  return reg;
}

/** Captures what the handler wrote, without a socket. */
function call(handler: ReturnType<typeof listRunnersHandler>): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (text: string) => {
      body = JSON.parse(text);
    },
  } as unknown as Parameters<typeof handler>[1];
  handler({} as Parameters<typeof handler>[0], res, {});
  return { status, body };
}

describe("GET /api/runners on a standalone host", () => {
  it("answers the shape the façade parses, even with nothing installed", () => {
    const { status, body } = call(listRunnersHandler(registryOf("claude"), () => false));
    expect(status).toBe(200);
    // Empty `items` and a missing route are the same thing to `orNotSupported`, which is how
    // this went unnoticed — but only one of them is a host saying "I have no runners".
    expect(body).toEqual({ items: [] });
  });

  it("lists only runners whose binary is actually here", () => {
    const installed = new Set(["claude"]);
    const { body } = call(listRunnersHandler(registryOf("claude", "codex"), (c) => installed.has(c)));
    expect((body as { items: Array<{ id: string }> }).items.map((r) => r.id)).toEqual(["claude"]);
  });

  it("names a native runner the way the desktop does", () => {
    const { body } = call(listRunnersHandler(registryOf("claude", "codex"), () => true));
    expect((body as { items: unknown[] }).items).toEqual([
      { id: "claude", name: "Claude Code", claudeFamily: false, custom: false, pinsTuning: false },
      { id: "codex", name: "Codex", claudeFamily: false, custom: false, pinsTuning: false },
    ]);
  });

  it("marks a ccs account as the claude-family wrapper it is", () => {
    // `ccs:<account>` runs the `claude` binary under another config dir, so Lotus' hooks fire
    // for it and it can be gated — which is exactly what `claudeFamily` tells the phone.
    const { body } = call(listRunnersHandler(registryOf("ccs:initech"), () => true));
    expect((body as { items: unknown[] }).items).toEqual([
      {
        id: "ccs:initech",
        name: "initech",
        claudeFamily: true,
        custom: true,
        pinsTuning: false,
      },
    ]);
  });

  it("checks the binary a runner actually needs, not its id", () => {
    // A ccs account is startable when `claude` is, never when a `ccs:initech` binary is.
    const asked: string[] = [];
    call(listRunnersHandler(registryOf("ccs:initech", "codex"), (c) => {
      asked.push(c);
      return true;
    }));
    expect(asked).toEqual(["claude", "codex"]);
  });

  it("keeps a runner it has no name for, rather than hiding it", () => {
    // A runner added to the registry and not to the label table is still startable, and a
    // phone that cannot see it cannot start it.
    const { body } = call(listRunnersHandler(registryOf("qwen"), () => true));
    expect((body as { items: Array<{ id: string; name: string }> }).items).toEqual([
      { id: "qwen", name: "qwen", claudeFamily: false, custom: false, pinsTuning: false },
    ]);
  });

  it("works with no probe injected, which is how app.ts calls it", () => {
    expect(call(listRunnersHandler(registryOf("claude"))).status).toBe(200);
  });
});
