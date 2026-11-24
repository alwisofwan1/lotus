import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../../core/api-error.js";
import { DeviceStore } from "../device-store.js";
import { buildMobileRouter, type MobileRouterDeps } from "../http-routes.js";
import { PairingService } from "../pairing.js";
import { call } from "./support/call.js";
import { assertFixture, FIXTURES } from "./support/fixtures.js";
import { renewalPayload } from "../refresh-key.js";
import { testRefreshKey } from "./support/refresh-keys.js";

const HOST = { hostId: "mac", hostLabel: "MacBook", mode: "client" } as const;

/**
 * The three routes Chat mode is built on, and the one that keeps a phone paired.
 *
 * They shipped between 2026-08-03 and 08-04 without fixtures, so the newest and
 * most intricate payloads — a permission prompt's options, a read-back sentence,
 * a transcript entry's optional diff stat — were the only ones the Dart side
 * would have had to guess at.
 *
 * The mocked `api` returns what the **Rust** handlers serialise, verified against
 * `apps/desktop/src-tauri/src/api_server/handlers/fleet.rs` and
 * `agent_hooks/transcript.rs`: no `hostSupports` field (the façade adds that only
 * when the route is missing), and `linesAdded`/`linesRemoved`/`readback` omitted
 * rather than nulled.
 */
describe("contract fixtures — REST", () => {
  let dir: string;
  let devices: DeviceStore;
  let pairing: PairingService;
  let api: MobileRouterDeps["api"];
  let router: ReturnType<typeof buildMobileRouter>;
  const now = Date.parse("2026-08-02T10:00:00Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-contract-rest-"));
    devices = new DeviceStore(join(dir, "devices.json"), () => now);
    pairing = new PairingService(devices, () => now);
    api = {
      readCellTranscript: vi.fn().mockResolvedValue({
        paneId: "p-1",
        total: 3,
        entries: [
          {
            event: "tool-post",
            status: "running",
            title: "Edit",
            body: "src/legacy/shim.ts",
            userPrompt: "clean up the legacy files",
            toolTarget: "src/legacy/shim.ts",
            linesAdded: 0,
            linesRemoved: 34,
            timestamp: now,
          },
          // No diff stat at all: a Read changed nothing, and "absent" is a
          // different claim from `+0 −0`. A Dart model that defaults these to
          // zero would render a diff badge on every read.
          {
            event: "tool-pre",
            status: "running",
            title: "Read",
            body: "src/legacy/shim.ts",
            userPrompt: "clean up the legacy files",
            toolTarget: "src/legacy/shim.ts",
            timestamp: now + 1_000,
          },
          // The turn's own words, and this one was cut. Chat renders `body` as the
          // agent's whole message, so a client that ignores `bodyTruncated` shows a
          // sentence stopping mid-word as though the agent stopped there. Carried in
          // the fixture for the same reason the diff-less entry above is: the two
          // shapes are only told apart by a field that is easy to forget.
          {
            event: "stop",
            status: "idle",
            title: "Finished working",
            body: "I removed the shim and updated the three call sites. The last one",
            bodyTruncated: true,
            userPrompt: "clean up the legacy files",
            toolTarget: "",
            timestamp: now + 2_000,
          },
        ],
      }),
      transcribeAudio: vi
        .fn()
        .mockResolvedValue({ text: "delete the legacy shim", provider: "openai" }),
      readCellPermission: vi.fn().mockResolvedValue({
        paneId: "p-1",
        awaiting: true,
        prompt: {
          question: "Do you want to delete src/legacy/shim.ts?",
          options: [
            { key: "1", label: "Yes", selected: true },
            {
              key: "2",
              label: "Yes, allow all edits during this session (shift+tab)",
              selected: false,
            },
            { key: "3", label: "No", selected: false },
          ],
        },
        readback:
          "Do you want to delete src/legacy/shim.ts? Option 1: Yes. " +
          "Option 2: Yes, allow all edits during this session. Option 3: No.",
      }),
      // One level of a directory the host opens — what the browse screen renders.
      browse: async () => ({
        roots: [
          { name: "lotus-workspaces", path: "/home/op/lotus-workspaces" },
          { name: "kerja", path: "/home/op/kerja" },
        ],
        page: {
          path: "/home/op/kerja",
          parent: null,
          entries: [
            { name: "tkt-backend", path: "/home/op/kerja/tkt-backend", isRepo: true, branch: "feat/payments", children: 12, isProject: false },
            { name: "notes", path: "/home/op/kerja/notes", isRepo: false, branch: null, children: 4, isProject: true },
          ],
          takeable: true,
          whyNot: null,
        },
      }),
      // A finished clone, which is the state the phone spends the longest rendering.
      cloneStatus: async (taskId: string) => ({
        taskId, state: "done", step: "registering",
        name: "tkt-worker", path: "/home/op/lotus-workspaces/tkt-worker",
      }),
    } as unknown as MobileRouterDeps["api"];

    router = buildMobileRouter({
      api,
      devices,
      pairing,
      host: HOST,
      audit: () => undefined,
      // `p-1` has a directory; `p-9` is not in the fleet at all — the `no_cwd` fixture.
      fleetSnapshot: async () => [
        { paneId: "p-1", workspaceId: "ws-lotus", agentType: "claude", title: "Chase", status: "live", isAlive: true, cwd: "/Users/op/code/lotus" } as never,
      ],
      // What a real repository answers, keyed by the git subcommand — one modified
      // tracked file with a numstat, one deleted, one untracked, and a binary.
      // `stderr` added at the boundary so each scripted answer stays one line.
      git: async (_cwd, args) => ({ stderr: "", ...answer(args) }),
    });
  });

  function answer(args: string[]): { code: number; stdout: string } {
    {
        switch (args[0]) {
          case "rev-parse":
            return { code: 0, stdout: "true\n" };
          case "status":
            return { code: 0, stdout: " M src/legacy/shim.ts\0 D src/legacy/README.md\0?? src/legacy/notes.md\0 M assets/logo.png\0" };
          case "diff":
            if (args.includes("--no-index") && args.includes("--numstat")) return { code: 1, stdout: "12\t0\tsrc/legacy/notes.md\n" };
            if (args.includes("--numstat")) return { code: 0, stdout: "31\t4\tsrc/legacy/shim.ts\n0\t18\tsrc/legacy/README.md\n-\t-\tassets/logo.png\n" };
            return {
              code: 1,
              stdout: "diff --git a/src/legacy/shim.ts b/src/legacy/shim.ts\n--- a/src/legacy/shim.ts\n+++ b/src/legacy/shim.ts\n@@ -1,3 +1,4 @@\n-export const shim = true;\n+export const shim = false;\n+export const cursor = 0;\n",
            };
          default:
            return { code: 128, stdout: "" };
        }
    }
  }

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function pairedToken(): Promise<string> {
    const { code } = pairing.create();
    const res = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });
    return (res.json as { deviceToken: string }).deviceToken;
  }

  it("rest-transcript matches what GET /m/cell/:paneId/transcript returns", async () => {
    const res = await call(router, "GET", "/m/cell/p-1/transcript", undefined, await pairedToken());

    assertFixture("rest-transcript", res.json);
  });

  /**
   * The same page as `rest-transcript`, as turns of typed parts (`types/conversation.ts`).
   * Generated from the same mocked read, so the two fixtures can never describe different
   * conversations — and the Dart side parses both from one source of truth.
   */
  it("rest-conversation matches what GET /m/cell/:paneId/conversation returns", async () => {
    const res = await call(router, "GET", "/m/cell/p-1/conversation", undefined, await pairedToken());

    assertFixture("rest-conversation", res.json);
  });

  it("rest-conversation-unsupported is the same route on a desktop without the transcript read", async () => {
    (api.readCellTranscript as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(404, "no such route"));
    const res = await call(router, "GET", "/m/cell/p-1/conversation", undefined, await pairedToken());

    assertFixture("rest-conversation-unsupported", res.json);
  });

  it("rest-permission matches what GET /m/cell/:paneId/permission returns", async () => {
    const res = await call(router, "GET", "/m/cell/p-1/permission", undefined, await pairedToken());

    assertFixture("rest-permission", res.json);
  });

  /**
   * The same route when the cell is holding a **question** rather than a permission. The
   * question rides whole — every option's own sentence with it — and the old `{key,label}`
   * prompt rides beside it, so a phone built before `question` still draws the same digits.
   */
  it("rest-permission-question carries the question, not a permission wearing a flag", async () => {
    (api.readCellPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      paneId: "p-1",
      awaiting: true,
      question: [
        {
          question: "Tabs or spaces?",
          header: "Indentation",
          options: [
            { key: "1", label: "Spaces", description: "Indent with spaces." },
            { key: "2", label: "Tabs", description: "Indent with tab characters." },
          ],
        },
      ],
      prompt: {
        question: "Tabs or spaces?",
        ask: "question",
        options: [
          { key: "1", label: "Spaces", selected: false },
          { key: "2", label: "Tabs", selected: false },
        ],
      },
      readback: "Tabs or spaces? 1 Spaces, 2 Tabs",
    });
    const res = await call(router, "GET", "/m/cell/p-1/permission", undefined, await pairedToken());

    assertFixture("rest-permission-question", res.json);
  });

  it("rest-stt matches what POST /m/stt returns", async () => {
    const res = await call(
      router,
      "POST",
      "/m/stt",
      { audioBase64: "AAAA", mime: "audio/webm" },
      await pairedToken(),
    );

    assertFixture("rest-stt", res.json);
  });

  it("rest-result matches what GET /m/cell/:paneId/result returns", async () => {
    const res = await call(router, "GET", "/m/cell/p-1/result", undefined, await pairedToken());

    assertFixture("rest-result", res.json);
  });

  it("rest-result-no-cwd says the fleet knows no directory, rather than an empty change list", async () => {
    const res = await call(router, "GET", "/m/cell/p-9/result", undefined, await pairedToken());

    assertFixture("rest-result-no-cwd", res.json);
  });

  it("rest-browse matches what GET /m/fs returns", async () => {
    const res = await call(router, "GET", "/m/fs?path=%2Fhome%2Fop%2Fkerja", undefined, await pairedToken());

    assertFixture("rest-browse", res.json);
  });

  it("rest-clone-job matches what GET /m/projects/clone/:taskId returns", async () => {
    const res = await call(router, "GET", "/m/projects/clone/clone_1", undefined, await pairedToken());

    assertFixture("rest-clone-job", res.json);
  });

  it("rest-diff matches what GET /m/cell/:paneId/diff returns", async () => {
    const res = await call(router, "GET", "/m/cell/p-1/diff?file=src%2Flegacy%2Fshim.ts", undefined, await pairedToken());

    assertFixture("rest-diff", res.json);
  });

  it("refuses a diff path that could climb out of the project", async () => {
    for (const bad of ["../../etc/passwd", "/etc/passwd", ""]) {
      const res = await call(router, "GET", `/m/cell/p-1/diff?file=${encodeURIComponent(bad)}`, undefined, await pairedToken());
      expect(res.status, bad).toBe(400);
    }
  });

  it("rest-devices-refresh matches what POST /m/devices/refresh returns", async () => {
    const res = await call(router, "POST", "/m/devices/refresh", {}, await pairedToken());
    const body = res.json as Record<string, unknown>;

    // The token is random by construction, as in `rest-pair`; the shape is the contract.
    assertFixture("rest-devices-refresh", { ...body, deviceToken: "<opaque>" });
  });

  it("rest-devices-renew-challenge and rest-devices-renew match the renewal round trip", async () => {
    const key = testRefreshKey();
    const { code } = pairing.create();
    const paired = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "Pixel", refreshKey: key.publicKey });
    const { deviceId } = paired.json as { deviceId: string };

    const challenge = await call(router, "POST", "/m/devices/renew/challenge", { deviceId });
    const { nonce } = challenge.json as { nonce: string };
    const renewed = await call(router, "POST", "/m/devices/renew", {
      deviceId, nonce, signature: key.sign(renewalPayload(deviceId, nonce)),
    });

    // The nonce is random and its expiry reads the wall clock; the shape is the contract.
    assertFixture("rest-devices-renew-challenge", { ...(challenge.json as object), nonce: "<opaque>", expiresAt: now + 120_000 });
    assertFixture("rest-devices-renew", { ...(renewed.json as object), deviceToken: "<opaque>" });
  });

  /**
   * A Standalone Host has no hook pipeline, so its API has neither route (§7 no.
   * 10). The phone still gets 200 and a shape it can parse, and ADR-3 puts both
   * hosts in v1 — so this is not an edge case, it is the VPS answer.
   */
  describe("a host without the hook pipeline", () => {
    beforeEach(() => {
      const notFound = new ApiError(404, "Not Found");
      (api.readCellTranscript as ReturnType<typeof vi.fn>).mockRejectedValue(notFound);
      (api.readCellPermission as ReturnType<typeof vi.fn>).mockRejectedValue(notFound);
    });

    it("rest-transcript-unsupported says so rather than looking empty", async () => {
      const res = await call(router, "GET", "/m/cell/p-1/transcript", undefined, await pairedToken());

      assertFixture("rest-transcript-unsupported", res.json);
    });

    // `awaiting: false` here means "cannot know", not "not waiting" — the
    // difference `hostSupports` exists to carry.
    it("rest-permission-unsupported says so rather than 'nothing to do'", async () => {
      const res = await call(router, "GET", "/m/cell/p-1/permission", undefined, await pairedToken());

      assertFixture("rest-permission-unsupported", res.json);
    });
  });

  /**
   * Dictation has the same fork with a different cause: the host is fine, it is just
   * set to transcribe on the device (`browser` is the shipped default). The phone
   * records again with its own recognizer instead of showing a failure.
   */
  it("rest-stt-unsupported is a fork, not a failure", async () => {
    (api.transcribeAudio as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(503, "no server-side STT provider active"),
    );

    const res = await call(
      router,
      "POST",
      "/m/stt",
      { audioBase64: "AAAA", mime: "audio/webm" },
      await pairedToken(),
    );

    assertFixture("rest-stt-unsupported", res.json);
  });

  /**
   * The guard that would have caught the gap this file closes.
   *
   * Routes are read from the router, not from a second hand-written list: the
   * three undocumented routes existed in code, in the README's absence, and every
   * unit test passed the whole time. A new route now has to name its fixture — or
   * say out loud why it has none.
   */
  describe("route coverage", () => {
    const FIXTURE_FOR: Record<string, string> = {
      "POST /m/pair": "rest-pair",
      "GET /m/bootstrap": "rest-bootstrap",
      "GET /m/cell/:paneId/transcript": "rest-transcript",
      "GET /m/cell/:paneId/conversation": "rest-conversation",
      "GET /m/cell/:paneId/permission": "rest-permission",
      "POST /m/devices/refresh": "rest-devices-refresh",
      "POST /m/devices/renew/challenge": "rest-devices-renew-challenge",
      "POST /m/devices/renew": "rest-devices-renew",
      "POST /m/stt": "rest-stt",
      "GET /m/cell/:paneId/result": "rest-result",
      "GET /m/cell/:paneId/diff": "rest-diff",
      "GET /m/projects/clone/:taskId": "rest-clone-job",
      "GET /m/fs": "rest-browse",
    };

    /** Routes with no fixture, each with the reason it does not need one. */
    const WAIVED: Record<string, string> = {
      "POST /m/cell/:paneId/dispatch": "answers { ok: true }; the interesting shape is the request",
      "POST /m/cell/:paneId/stop": "answers { ok: true }",
      "POST /m/cell/:paneId/posture":
        "answers { ok: true, mode } and echoes back what it was given; the shapes that matter are its two refusals, and both are statuses rather than bodies — 400 for a stop this host does not advertise, 409 for a cell whose posture cannot be moved while it runs, which is covered by a handler test",
      "POST /m/cell/:paneId/input":
        "answers { ok: true }; the interesting shape is the request, and its body is opaque bytes the phone's emulator encoded — a fixture would only pin an example keystroke",
      "POST /m/cells":
        "answers the desktop's own spawn result ({ paneId, … }); the shape that matters is the request, and its `permissionMode` is covered by a handler test",
      "DELETE /m/cell/:paneId":
        "answers { ok: true, paneId }; the shape that matters is the 503 it passes through when the desktop window is not on a workspace, which is a status rather than a body",
      "POST /m/cell/:paneId/size":
        "answers { held, token? }, two fields the phone reads only to keep or drop its lease; what matters is the rule behind it (ADR-6 addendum 2026-10-05), which is the desktop's `size_lease.rs` tests, and the 400/404 refusals, which are statuses",
      "POST /m/cell/:paneId/size/release": "answers { ok: true }, even for a pane that is gone",
      "DELETE /m/devices/:deviceId": "answers { ok: true }",
      "GET /m/tasks": "tasks are out of MVP scope (MVP.md); shape owned by the desktop task API",
      "POST /m/tasks": "same as GET /m/tasks",
      "PATCH /m/tasks/:id": "same as GET /m/tasks",
      "GET /m/devices": "desktop admin surface — the phone has no device list in the two MVP screens",
      "POST /m/devices/push-token":
        "answers { ok: true }; the interesting shape is the request, and the reply must stay empty — a fixture echoing a registration token would put a device capability in the repo",
      "DELETE /m/devices/push-token": "answers { ok: true }",
      "POST /m/projects":
        "answers the `HostedProject` it just took ({ id, name, path }) — the same shape `GET /m/bootstrap` already carries a list of, and the fixture for that one pins it; what matters here is the request and its three refusals, all statuses: 403 outside every root, 404 for a directory that is not there, 409 for one this host already holds",
      "DELETE /m/projects/:id":
        "answers { ok: true } and is idempotent; the property that matters is what it does NOT do, which is touch the directory, and that is a handler test rather than a body",
      "POST /m/projects/clone":
        "answers the same job shape as GET /m/projects/clone/:taskId, which has the fixture; what differs here is the request, and the shapes that matter are its refusals — 400 for a folder name that cannot become a project, 409 for one already taken, 503 for a host with no workspace root — statuses rather than bodies, each covered by a handler test",
    };

    it("documents or explicitly waives every route on the mobile surface", () => {
      const routes = router.list().map((r) => `${r.method} ${r.path}`);

      expect([...routes].sort()).toEqual(
        [...Object.keys(FIXTURE_FOR), ...Object.keys(WAIVED)].sort(),
      );
    });

    it("has the fixture file every documented route names", () => {
      const missing = Object.values(FIXTURE_FOR).filter(
        (name) => !existsSync(join(FIXTURES, `${name}.json`)),
      );

      expect(missing).toEqual([]);
    });
  });
});
