import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NativeConversation } from "../../codex-app-server/native-conversation.js";
import type { CodexSessionOptions } from "../../codex-app-server/session.js";
import { CellBook } from "../cell-book.js";
import { CUT_OFF_MESSAGE } from "../saved-turns.js";
import { StructuredSessions } from "../structured-sessions.js";

/** Never spawns: `failStart` plays a runner whose saved thread is gone. */
class FakeSession {
  readonly conversation: NativeConversation;
  alive = true;
  thread: string | undefined;
  prompts: string[] = [];
  constructor(readonly opts: CodexSessionOptions & { resumeThreadId?: string }, private readonly failStart: boolean, private readonly lateThread = false) {
    this.conversation = new NativeConversation(opts.paneId);
  }
  async start(): Promise<void> {
    if (this.failStart) throw new Error("no rollout found for thread");
    if (!this.lateThread) this.thread = this.opts.resumeThreadId ?? "thr-1";
  }
  async prompt(text: string): Promise<void> { this.prompts.push(text); }
  async interrupt(): Promise<void> {}
  decide(): boolean { return false; }
  close(): void { this.alive = false; }
}

/** One host process: a store over the shared book file. */
function host(path: string, failStart = false, lateThread = false) {
  const sessions: FakeSession[] = [];
  const store = new StructuredSessions({
    publishNotification: () => undefined,
    fleetChanged: () => undefined,
    book: new CellBook(path),
    createSession: (opts) => { const s = new FakeSession(opts, failStart, lateThread); sessions.push(s); return s; },
  });
  return { store, sessions };
}

const req = { workspaceId: "ws", cwd: "/srv/app", permissionMode: "yolo" };
const bookPath = () => join(mkdtempSync(join(tmpdir(), "restore-")), "structured-cells.json");

function oneTurn(c: NativeConversation, id: string, finish: boolean): void {
  c.apply("turn/started", { turn: { id, startedAt: 1 } });
  c.apply("item/completed", { turnId: id, item: { type: "userMessage", id: `${id}-u`, content: [{ type: "text", text: "hi" }] } });
  if (finish) c.apply("turn/completed", { turn: { id, status: "completed", completedAt: 2 } });
}

describe("StructuredSessions across a host restart", () => {
  it("brings a cell back with the same paneId, its thread resumed and its history kept", async () => {
    const path = bookPath();
    const first = host(path);
    const m = await first.store.spawn(req);
    oneTurn(first.sessions[0]!.conversation, "t1", true);
    first.store.closeAll();

    const second = host(path);
    await second.store.restore();
    expect(second.store.list().map((x) => [x.paneId, x.title, x.isAlive])).toEqual([[m.paneId, m.title, true]]);
    expect(second.sessions[0]?.opts).toMatchObject({ resumeThreadId: "thr-1", approvalPolicy: "never" });
    expect(second.store.page(m.paneId)?.turns).toHaveLength(1);
    expect(second.sessions[0]?.prompts).toEqual([]);
  });

  /** Seen on devbox-vps: Claude has no session id until it answers, and the save after a resume dropped the saved one. */
  it("keeps the resumed id through a second restart before the runner names its session", async () => {
    const path = bookPath();
    const first = host(path);
    const m = await first.store.spawn(req);
    first.store.closeAll();

    const second = host(path, false, true);
    await second.store.restore();
    second.store.closeAll();
    expect(new CellBook(path).all().find((c) => c.member.paneId === m.paneId)?.thread).toBe("thr-1");
  });

  it("marks a reply the restart cut off, and does not send it again", async () => {
    const path = bookPath();
    const first = host(path);
    const m = await first.store.spawn(req);
    oneTurn(first.sessions[0]!.conversation, "t1", false);
    first.store.closeAll();

    const second = host(path);
    await second.store.restore();
    const turn = second.store.page(m.paneId)?.turns.at(-1);
    expect(turn?.stopReason).toBe("cancelled");
    expect(turn?.parts.at(-1)).toMatchObject({ type: "error", message: CUT_OFF_MESSAGE });
    expect(second.sessions[0]?.prompts).toEqual([]);
  });

  it("keeps a cell that cannot resume, ended and saying why", async () => {
    const path = bookPath();
    const first = host(path);
    const m = await first.store.spawn(req);
    first.store.closeAll();

    const second = host(path, true);
    await second.store.restore();
    expect(second.store.list().map((x) => [x.paneId, x.isAlive])).toEqual([[m.paneId, false]]);
    const reason = second.store.page(m.paneId)?.turns.at(-1)?.parts[0];
    expect(reason?.type === "error" && reason.message).toContain("no rollout found");
    expect(await second.store.dispatch(m.paneId, "hello?")).toBe("unknown");
  });

  it("forgets a cell the operator closed", async () => {
    const path = bookPath();
    const first = host(path);
    const m = await first.store.spawn(req);
    first.store.close(m.paneId);
    first.store.closeAll();

    const second = host(path);
    await second.store.restore();
    expect(second.store.list()).toEqual([]);
  });
});

/** Seen 2026-11-24: a runner that dies while the host lives (Stop used to SIGINT it) left the cell answering "no longer running" for good. */
describe("StructuredSessions when a runner dies under a live host", () => {
  it("starts it again on the same conversation and delivers the message", async () => {
    const { store, sessions } = host(bookPath());
    const m = await store.spawn(req);
    oneTurn(sessions[0]!.conversation, "t1", true);
    sessions[0]!.alive = false;

    expect(await store.dispatch(m.paneId, "again")).toBe("sent");
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.opts).toMatchObject({ resumeThreadId: "thr-1" });
    expect(sessions[1]?.prompts).toEqual(["again"]);
    expect(store.list().map((x) => [x.paneId, x.isAlive])).toEqual([[m.paneId, true]]);
    expect(store.page(m.paneId)?.turns).toHaveLength(1);
  });

  it("starts one runner when two messages arrive while it is down", async () => {
    const { store, sessions } = host(bookPath());
    const m = await store.spawn(req);
    sessions[0]!.alive = false;

    const sent = await Promise.all([store.dispatch(m.paneId, "a"), store.dispatch(m.paneId, "b")]);
    expect(sent).toEqual(["sent", "sent"]);
    expect(sessions).toHaveLength(2);
  });
});
