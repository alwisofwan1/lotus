import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { cellPermissionHandler, hookTurnHandler, type HookTurnSink } from "../hooks.js";

/**
 * The rule that shapes every branch here: **a hook must never fail.** A `PreToolUse` hook that
 * exits non-zero BLOCKS the tool call (confirmed by the ADR-8 spike, which used exactly that to
 * implement gating), so a hook author who sees a 4xx is tempted to retry or surface it. Nothing
 * this endpoint could say is worth that risk, so every refusal is a 200 that says what it did.
 */

function call(handler: ReturnType<typeof hookTurnHandler>, body: unknown): Promise<{ status: number; json: any }> {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = "/v1/hook/turn";
  req.headers = {};

  return new Promise((resolve) => {
    let status = 0;
    const chunks: string[] = [];
    const res = {
      writeHead(code: number) { status = code; return res; },
      end(chunk?: string) {
        if (chunk !== undefined) chunks.push(chunk);
        resolve({ status, json: JSON.parse(chunks.join("")) });
      },
    } as unknown as ServerResponse;

    void handler(req, res, {});
    setImmediate(() => {
      if (body !== undefined) req.emit("data", typeof body === "string" ? body : JSON.stringify(body));
      req.emit("end");
    });
  });
}

const sink = () => {
  const recorded: Array<[string, string, number]> = [];
  return {
    recorded,
    handler: hookTurnHandler({ recordTurn: (p, s, at) => recorded.push([p, s, at]) } as HookTurnSink),
  };
};

describe("POST /v1/hook/turn", () => {
  it("records what a pane's hook said", async () => {
    const { handler, recorded } = sink();

    const res = await call(handler, { pane_id: "pane-7", status: "needs-input", at_ms: 1_800_000 });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, paneId: "pane-7", status: "needs-input" });
    expect(recorded).toEqual([["pane-7", "needs-input", 1_800_000]]);
  });

  it("accepts every status the schema defines, and nothing else", async () => {
    for (const status of ["idle", "needs-input", "error", "running", "ended"]) {
      const { handler, recorded } = sink();
      await call(handler, { pane_id: "p", status });
      expect(recorded).toHaveLength(1);
    }

    const { handler, recorded } = sink();
    // Dropped rather than stored: `awaitingPermission` reads this value, and a stray one would
    // sit in the map claiming something nobody defined.
    const res = await call(handler, { pane_id: "p", status: "banana" });
    expect(res.json).toMatchObject({ ok: false });
    expect(recorded).toEqual([]);
  });

  describe("never failing, because a non-zero hook blocks the tool", () => {
    it("answers 200 for a body it cannot parse", async () => {
      const { handler, recorded } = sink();

      const res = await call(handler, "{not json");

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: false });
      expect(recorded).toEqual([]);
    });

    it("answers 200 when the hook could not name its pane", async () => {
      const { handler, recorded } = sink();

      const res = await call(handler, { status: "needs-input" });

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: false, reason: "pane_id is required" });
      expect(recorded).toEqual([]);
    });

    it("answers 200 for a blank pane id", async () => {
      const { handler, recorded } = sink();
      expect((await call(handler, { pane_id: "   ", status: "idle" })).status).toBe(200);
      expect(recorded).toEqual([]);
    });
  });

  /**
   * A hook's clock is not trusted for ordering: skewed forward it would never age out, skewed
   * back it would look older than the TTL and vanish on the next read.
   */
  it("uses its own clock when the hook sent no usable time", async () => {
    const before = Date.now();
    const { handler, recorded } = sink();

    await call(handler, { pane_id: "p", status: "idle" });
    await call(handler, { pane_id: "p", status: "idle", at_ms: Number.NaN });

    for (const [, , at] of recorded) expect(at).toBeGreaterThanOrEqual(before);
  });
});

const PROMPT = [
  "Do you want to create approved.txt?",
  "\u276f 1. Yes",
  "  2. No",
  "",
].join("\n");

/** ADR-8's two signals, as the route answers them. */
describe("GET /api/fleet/:paneId/permission", () => {
  const get = (turns: any, panes: any, paneId = "pane-7") => {
    const handler = cellPermissionHandler(turns, panes);
    const req = new EventEmitter() as IncomingMessage;
    req.method = "GET";
    req.headers = {};
    return new Promise<any>((resolve) => {
      let status = 0;
      const chunks: string[] = [];
      const res = {
        writeHead(code: number) { status = code; return res; },
        end(chunk?: string) { if (chunk) chunks.push(chunk); resolve({ status, json: JSON.parse(chunks.join("")) }); },
      } as unknown as ServerResponse;
      void handler(req, res, { paneId });
    });
  };

  const turn = (status: string) => ({ statusOf: () => ({ status, at: Date.now(), agentType: "claude" }) });
  const noTurn = { statusOf: () => undefined };
  /** What the terminal drew, which is the only thing the digits can be read from. */
  const screen = (text: string, columns = 80) => ({ screenOf: async () => ({ text, columns }) });

  it("offers the digits only when the hook and the terminal agree", async () => {
    const res = await get(turn("needs-input"), screen(PROMPT));

    expect(res.json).toMatchObject({ paneId: "pane-7", hostSupports: true, awaiting: true });
    expect(res.json.prompt.options.map((o: any) => o.key)).toEqual(["1", "2"]);
    // Spoken form comes with it, so the answer can be given without looking.
    expect(res.json.readback).toContain("Option 1: Yes.");
  });

  /**
   * The cell IS waiting — saying otherwise hides a stuck agent — but no digit is offered, and a
   * client renders a pointer to the terminal instead of chips.
   */
  it("says waiting with no prompt when the terminal cannot be read", async () => {
    const res = await get(turn("needs-input"), screen("ordinary output\n"));

    expect(res.json).toMatchObject({ awaiting: true, prompt: null });
    expect(res.json).not.toHaveProperty("readback");
  });

  /**
   * **A card that cannot name the options must still show the words.**
   *
   * `awaiting: true, prompt: null` was honest and useless: the operator got one sentence
   * saying the options could not be read and a button to the terminal. The question itself —
   * which the terminal *did* print — never reached the phone. Measured 2026-09-08: the parser
   * fails on any prompt drawn inside a box or with a blank line above the options, which is
   * every `AskUserQuestion` and most of the rest.
   *
   * So the tail rides along. Not the digits: those still come from a successful parse only,
   * because a wrong digit approves the thing the operator meant to refuse (ADR-8). Reading is
   * safe; answering is what stays behind the terminal.
   */
  it("carries what the terminal drew when it could not name the options", async () => {
    const boxed = ["│ Save the indicator, or match Figma exactly?", "│", "│ ❯ 1. Keep it", "│   2. Remove it"].join("\n");
    const res = await get(turn("needs-input"), screen(boxed));

    expect(res.json).toMatchObject({ awaiting: true, prompt: null });
    expect(res.json.tail).toContain("Save the indicator");
    expect(res.json.tail).toContain("1. Keep it");
  });

  it("adds no tail when the options were read — the card already has the words", async () => {
    const res = await get(turn("needs-input"), screen(PROMPT));

    expect(res.json.prompt).not.toBeNull();
    expect(res.json).not.toHaveProperty("tail");
  });

  it("adds no tail for a cell that is not waiting", async () => {
    expect((await get(turn("idle"), screen(PROMPT))).json).not.toHaveProperty("tail");
  });

  /** A tail holds old prompts. Without a hook saying so, the last one is history. */
  it("ignores a prompt in the tail that no hook is asking about", async () => {
    expect((await get(noTurn, screen(PROMPT))).json).toMatchObject({ awaiting: false, prompt: null });
    expect((await get(turn("idle"), screen(PROMPT))).json).toMatchObject({ awaiting: false });
  });

  /**
   * `hostSupports: false` rather than `awaiting: false`: this host cannot see the pane at all,
   * and "not waiting" is a claim it has no basis for.
   */
  it("says it cannot tell about a pane with no live session", async () => {
    const res = await get(turn("needs-input"), { screenOf: async () => undefined });

    expect(res.json).toMatchObject({ hostSupports: false, awaiting: false, prompt: null });
  });
});

/**
 * The route reads the SCREEN, and the difference is the whole of `issues/17`.
 *
 * This is the shape the raw pipe-pane stream really had on `devbox-vps`: cursor moves instead of
 * newlines, column jumps instead of spaces. Parsing it would have produced the right digits
 * beside a fused, wrong question — a confident answer to a question the operator never saw.
 */
describe("the screen, not the stream", () => {
  const RAW_STREAM =
    "╬╬╬\rDoyouwanttocreategate17.txt?\r❯1. Yes\r  2. No\r";

  const withScreen = (text: string) => ({ screenOf: async () => ({ text, columns: 80 }) });
  const turnNeedsInput = { statusOf: () => ({ status: "needs-input", at: Date.now() }) };

  const ask = (panes: any) => {
    const handler = cellPermissionHandler(turnNeedsInput as any, panes);
    const req = new EventEmitter() as IncomingMessage;
    req.method = "GET";
    req.headers = {};
    return new Promise<any>((resolve) => {
      const chunks: string[] = [];
      const res = {
        writeHead() { return res; },
        end(chunk?: string) { if (chunk) chunks.push(chunk); resolve(JSON.parse(chunks.join(""))); },
      } as unknown as ServerResponse;
      void handler(req, res, { paneId: "p" });
    });
  };

  it("offers nothing when all it has is the raw stream", async () => {
    expect(await ask(withScreen(RAW_STREAM))).toMatchObject({ awaiting: true, prompt: null });
  });

  /** A backend with no terminal behind it says so, instead of guessing from bytes. */
  it("says waiting with no prompt when nothing could be rendered", async () => {
    expect(await ask(withScreen(""))).toMatchObject({
      hostSupports: true,
      awaiting: true,
      prompt: null,
    });
  });
});

/**
 * Slice 3.1. The hook stops re-encoding its own body and forwards the CLI's, because the path to
 * the transcript is a thing only the CLI knows — and because two escaping bugs were already paid
 * for building JSON by hand inside `sh`.
 */
describe("POST /v1/hook/turn — the CLI's own payload", () => {
  const withHeaders = (
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; json: any }> => {
    const req = new EventEmitter() as IncomingMessage;
    req.method = "POST";
    req.url = "/v1/hook/turn";
    req.headers = headers;
    return new Promise((resolve) => {
      let status = 0;
      const chunks: string[] = [];
      const res = {
        writeHead(code: number) { status = code; return res; },
        end(chunk?: string) {
          if (chunk !== undefined) chunks.push(chunk);
          resolve({ status, json: JSON.parse(chunks.join("")) });
        },
      } as unknown as ServerResponse;
      void handlerWithSources(req, res, {});
      setImmediate(() => {
        if (body !== undefined) {
          req.emit("data", typeof body === "string" ? body : JSON.stringify(body));
        }
        req.emit("end");
      });
    });
  };

  let recorded: Array<[string, string, number]> = [];
  let sources: Array<[string, unknown]> = [];
  let handlerWithSources: ReturnType<typeof hookTurnHandler>;

  beforeEach(() => {
    recorded = [];
    sources = [];
    handlerWithSources = hookTurnHandler(
      { recordTurn: (p, s, at) => recorded.push([p, s, at]) } as HookTurnSink,
      { record: (paneId, source) => sources.push([paneId, source]) },
    );
  });

  const CLAUDE_PAYLOAD = {
    session_id: "1f0b-aaaa",
    transcript_path: "/home/alwi/.claude/projects/-home-alwi-proj/1f0b.jsonl",
    cwd: "/home/alwi/proj",
    hook_event_name: "Notification",
  };

  it("takes the pane and status from headers and the source from the body", async () => {
    const res = await withHeaders(CLAUDE_PAYLOAD, {
      "x-lotus-pane-id": "pane-7",
      "x-lotus-status": "needs-input",
    });

    expect(res.json).toMatchObject({ ok: true, paneId: "pane-7", status: "needs-input" });
    expect(recorded).toEqual([["pane-7", "needs-input", expect.any(Number)]]);
    expect(sources).toEqual([[
      "pane-7",
      {
        transcriptPath: "/home/alwi/.claude/projects/-home-alwi-proj/1f0b.jsonl",
        sessionId: "1f0b-aaaa",
        cwd: "/home/alwi/proj",
      },
    ]]);
  });

  /** Old scripts are still on disk until the installer next runs. They must keep working. */
  it("still accepts the body-only shape it used to be sent", async () => {
    const res = await withHeaders({ pane_id: "pane-9", status: "idle" }, {});

    expect(res.json).toMatchObject({ ok: true, paneId: "pane-9" });
    expect(recorded).toEqual([["pane-9", "idle", expect.any(Number)]]);
    expect(sources).toEqual([]);
  });

  /**
   * The turn is the half that gates approvals, so it is recorded even when the CLI's payload is
   * unreadable. Losing a transcript path costs a Chat page; losing the turn costs the approval.
   */
  it("records the turn even when the body is not JSON at all", async () => {
    const res = await withHeaders("not json {", {
      "x-lotus-pane-id": "pane-7",
      "x-lotus-status": "needs-input",
    });

    expect(res.json).toMatchObject({ ok: true });
    expect(recorded).toHaveLength(1);
    expect(sources).toEqual([]);
  });

  /**
   * Claude 2.1.329 sends 14 notification types; only a few ask this pane anything. The idle notice
   * (devbox-vps, 2026-11-17) and then other informational ones put PERMISSION cards on idle agents.
   */
  it("records needs-input only for notification types that ask the operator something", async () => {
    const headers = { "x-lotus-pane-id": "pane-7", "x-lotus-status": "needs-input" };
    const notices = ["idle_prompt", "agent_completed", "agent_needs_input", "push_notification", "auth_success", "plugin_notification"]
      .map((type) => ({ ...CLAUDE_PAYLOAD, message: "something", notification_type: type }));
    // An older Claude sends no type; the idle wording alone still names it.
    const idleUntyped = { ...CLAUDE_PAYLOAD, message: "Claude is waiting for your input" };

    for (const body of [...notices, idleUntyped]) {
      const res = await withHeaders(body, headers);
      expect(res.json).toMatchObject({ ok: false, reason: "not a question" });
    }
    expect(recorded).toEqual([]);

    const asks = ["permission_prompt", "worker_permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]
      .map((type) => ({ ...CLAUDE_PAYLOAD, message: "Claude needs your permission to use Bash", notification_type: type }));
    // Untyped and not the idle wording: fails towards alerting.
    const untypedAsk = { ...CLAUDE_PAYLOAD, message: "Claude needs your permission to use Bash" };
    for (const body of [...asks, untypedAsk]) await withHeaders(body, headers);
    expect(recorded).toHaveLength(5);
  });

  it("drops a header pane id carrying control characters", async () => {
    const res = await withHeaders(CLAUDE_PAYLOAD, {
      "x-lotus-pane-id": "pane\n7",
      "x-lotus-status": "needs-input",
    });

    expect(res.json).toMatchObject({ ok: false });
    expect(recorded).toEqual([]);
    expect(sources).toEqual([]);
  });
});
