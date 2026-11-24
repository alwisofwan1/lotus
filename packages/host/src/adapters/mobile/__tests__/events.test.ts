import { describe, expect, it } from "vitest";

import { hostFeatures, parseClientMessage } from "../events.js";

/**
 * A Standalone Host has no hook pipeline — no watcher, no transcript ring, no
 * `pane_turn` — because all three live in the desktop's Rust side (PLAN.md §7 no.
 * 10). It used to advertise `transcript` and `permission` anyway and then answer
 * `hostSupports: false` on every call, which left the app no way to decide the
 * shape of a screen before opening it.
 */
describe("hostFeatures", () => {
  it("advertises the desktop-backed features on a desktop host", () => {
    for (const feature of ["transcript", "permission", "stt"]) {
      expect(hostFeatures("client")).toContain(feature);
    }
  });

  // `stt` joins the two hook features for a different reason with the same shape:
  // the provider registry and its key live in Rust, and ADR-11 keeps keys off the
  // phone — so a VPS host has nothing to transcribe with.
  it("does not advertise them on a standalone host", () => {
    for (const feature of ["transcript", "permission", "stt"]) {
      expect(hostFeatures("standalone")).not.toContain(feature);
    }
  });

  /**
   * Slice 2.4, and asserted on both sides because until 2026-09-05 nothing did: the change
   * was visible only as a diff in a golden fixture, which describes what the list IS without
   * anyone having said what it SHOULD be.
   *
   * A standalone host serves these itself now (`routes/fleet-lifecycle.ts`), against its own
   * `HostedProject` rather than a desktop window's workspace.
   */
  it("advertises starting and ending a cell in BOTH modes", () => {
    for (const feature of ["spawn", "close"]) {
      expect(hostFeatures("standalone")).toContain(feature);
      expect(hostFeatures("client")).toContain(feature);
    }
  });

  /**
   * Slice 1b. A TUI cell can be asked about only where a hook is installed to say so — the
   * terminal alone cannot tell a live prompt from one printed ten minutes ago (ADR-8).
   */
  it("advertises permission on a standalone host once a hook reports turns", () => {
    expect(hostFeatures("standalone", { hooks: true })).toContain("permission");
    expect(hostFeatures("standalone", {})).not.toContain("permission");
  });

  /// `projects-create` is a deployment capability, not a mode one: a standalone host
  /// configured with a fixed `PROJECTS_JSON` list has nowhere to clone into and says so.
  it("promises cloning only where there is a workspace root to clone into", () => {
    expect(hostFeatures("standalone", { projectsCreate: true })).toContain("projects-create");
    expect(hostFeatures("standalone", {})).not.toContain("projects-create");
    // A desktop owns its own project registry; this route is not on its API at all.
    expect(hostFeatures("client", {})).not.toContain("projects-create");
  });

  /// Two flags, not one, and the order they ship in is the reason: a host can clone before it
  /// opens any directory for browsing, and a phone must be able to tell those two apart.
  it("promises browsing only where there are directories to open", () => {
    expect(hostFeatures("standalone", { projectsBrowse: true })).toContain("projects-browse");
    expect(hostFeatures("standalone", { projectsCreate: true })).not.toContain("projects-browse");
    expect(hostFeatures("client", {})).not.toContain("projects-browse");
  });

  /**
   * Slice 3.5, and it is the same hook that buys these — for a different reason than the one
   * this test used to assert.
   *
   * `transcript` and `conversation` were withheld while they were expected to be built from the
   * drop file's CONTENTS. They are not: they are read from the runner's **own** transcript file,
   * whose path the hook reports (`transcript_path`, slice 3.1). So the hook is exactly the
   * precondition — with it the host knows which file to read, and without it it does not.
   *
   * The flag stays a hint about shape, not a promise per cell: a codex TUI cell still answers
   * `hostSupports: false`, because this host has a reader for claude's format and not codex's.
   */
  it("advertises Chat on a standalone host once a hook reports turns", () => {
    const features = hostFeatures("standalone", { hooks: true });

    expect(features).toContain("transcript");
    expect(features).toContain("conversation");
  });

  it("promises no Chat where no hook is installed to name the file", () => {
    const features = hostFeatures("standalone", {});

    expect(features).not.toContain("transcript");
    expect(features).not.toContain("conversation");
  });

  it("says each capability once when a host has both a hook and Codex", () => {
    const features = hostFeatures("standalone", { hooks: true, structuredSpawn: true });

    for (const feature of ["permission", "transcript", "conversation"]) {
      expect(features.filter((f) => f === feature)).toHaveLength(1);
    }
  });

  it("says permission once when a host has both a hook and Codex", () => {
    const features = hostFeatures("standalone", { hooks: true, structuredSpawn: true });

    expect(features.filter((f) => f === "permission")).toHaveLength(1);
  });

  /**
   * Reversed on 2026-09-10 (`plans/pocket-without-laptop/issues/24`). The old rule read:
   * *"`spawn-tuning` rides on `spawn` and did NOT come with it: a standalone host can start a
   * cell and has no picker behind `models`/`efforts`."* The first half was never the reason —
   * `tuneRunners()` never depended on mode, so the scales were already on the wire. The
   * second half was true and is now fixed: `fleet-lifecycle.ts` forwards `model`/`effort` and
   * all three runners write them (issues 21-23).
   *
   * Both modes, and the pair asserted together on purpose: `hostFeatures` builds client as
   * BASE + DESKTOP_ONLY, so moving a name between those lists can take it away from the
   * desktop while adding it to the VPS.
   */
  it("offers the summon knobs in both modes, now that both honour them", () => {
    expect(hostFeatures("standalone")).toContain("spawn-tuning");
    expect(hostFeatures("client")).toContain("spawn-tuning");
  });

  // A standalone host that runs Codex itself answers `permission`, `transcript` and
  // `conversation` from `StructuredSessions`, which touches no desktop at all — both routes
  // consult `deps.structured` BEFORE the desktop fallback (`cell-routes.ts:259,272`). Not
  // advertising them left the phone gating itself off a capability the host had:
  // `paired_host.dart` reads `hostCaps` and never calls the route.
  it("advertises the chat features on a standalone host that runs Codex itself", () => {
    for (const feature of ["permission", "transcript", "conversation"]) {
      expect(hostFeatures("standalone", { structuredSpawn: true })).toContain(feature);
    }
  });

  it("still withholds stt there, which needs a key store no VPS has", () => {
    // The narrowing that survives: ADR-11 keeps provider keys off the phone, and a VPS has
    // nothing to transcribe with. Codex on PATH changes nothing about that.
    expect(hostFeatures("standalone", { structuredSpawn: true })).not.toContain("stt");
  });

  it("keeps everything a standalone host really can do", () => {
    // The narrowing is Chat's two sources only. A VPS still streams, dispatches
    // and stops — Terminal mode is fully alive there, which is what makes the
    // "read-only for Chat" answer honest rather than a quiet demotion.
    for (const feature of ["fleet", "dispatch", "stop", "tasks", "stream", "device-refresh"]) {
      expect(hostFeatures("standalone")).toContain(feature);
    }
  });
});

describe("parseClientMessage", () => {
  it("accepts a subscribe message naming a pane", () => {
    expect(parseClientMessage('{"type":"subscribe","paneId":"p-1"}')).toEqual({
      type: "subscribe",
      paneId: "p-1",
    });
  });

  it("accepts a subscribe message that clears the subscription", () => {
    expect(parseClientMessage('{"type":"subscribe","paneId":null}')).toEqual({
      type: "subscribe",
      paneId: null,
    });
  });

  it("accepts a resume message with a byte offset", () => {
    expect(parseClientMessage('{"type":"resume","paneId":"p-1","fromByte":2048}')).toEqual({
      type: "resume",
      paneId: "p-1",
      fromByte: 2048,
    });
  });

  it("accepts a ping", () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  // Everything below is the reason this function exists: the socket is reachable
  // from another device, so every inbound frame is untrusted input.
  it.each([
    ["not json at all", "definitely-not-json"],
    ["a JSON scalar", '"subscribe"'],
    ["a JSON array", '["subscribe"]'],
    ["null", "null"],
    ["a missing type", '{"paneId":"p-1"}'],
    ["an unknown type", '{"type":"drop-tables"}'],
    ["a non-string type", '{"type":42}'],
    ["subscribe with a numeric paneId", '{"type":"subscribe","paneId":7}'],
    ["subscribe with no paneId field", '{"type":"subscribe"}'],
    ["resume with no paneId", '{"type":"resume","fromByte":10}'],
    ["resume with a negative offset", '{"type":"resume","paneId":"p-1","fromByte":-1}'],
    ["resume with a fractional offset", '{"type":"resume","paneId":"p-1","fromByte":1.5}'],
    ["resume with a string offset", '{"type":"resume","paneId":"p-1","fromByte":"10"}'],
    ["resume with a null paneId", '{"type":"resume","paneId":null,"fromByte":0}'],
  ])("rejects %s", (_label, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it("rejects a paneId long enough to be an abuse attempt", () => {
    const raw = JSON.stringify({ type: "subscribe", paneId: "p".repeat(1025) });

    expect(parseClientMessage(raw)).toBeNull();
  });

  it("ignores unknown extra fields rather than failing the frame", () => {
    expect(parseClientMessage('{"type":"ping","somethingNew":true}')).toEqual({ type: "ping" });
  });
});
