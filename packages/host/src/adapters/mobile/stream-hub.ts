import type { FleetMember } from "../../types/fleet.js";
import type { ConversationUpdate } from "../../types/conversation.js";
import { ConversationDeltaLog, type DeltasSince } from "./conversation/delta-log.js";
import type { ConversationListener } from "../../types/conversation.js";
import { ConversationGrammar, type GrammarViolation } from "./conversation/grammar.js";
import type { NotificationEvent } from "../../types/notifications.js";
import type { Device } from "./device-store.js";
import {
  hostFeatures,
  MOBILE_PROTOCOL_VERSION,
  parseClientMessage,
  type HostCaps,
  type ServerEvent,
} from "./events.js";
import type { MobileHostIdentity } from "./http-routes.js";

/** The only thing the hub needs from a transport — keeps `ws` out of the unit tests. */
export interface StreamSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface StreamConnection {
  readonly device: Device;
  readonly socket: StreamSocket;
  /** Pane this connection is tailing, if any. */
  paneId: string | null;
}

export interface ResumeRequest {
  paneId: string;
  fromByte: number;
}

export interface StreamHubDeps {
  host: MobileHostIdentity;

  /**
   * Whether this host can wake a backgrounded app. Read on every `hello` rather than
   * baked into a string list, because `hello` is the authoritative place a client
   * learns what it may rely on (ADR-10) — and there is exactly one function producing
   * that list, for the reason `hostFeatures` documents at length.
   */
  pushEnabled?: boolean;
  structuredSpawn?: boolean;
  /** Whether an agent hook reports turns here — what makes TUI `permission` observable. */
  hooks?: boolean;
  /** Whether this host has a workspace root to clone into — `projects-create`. */
  projectsCreate?: boolean;
  /** Whether it opens directories for browsing — `projects-browse`. */
  projectsBrowse?: boolean;
  /**
   * Told when a delta breaks the conversation grammar, so a producer that misbehaves against a
   * real CLI is heard here rather than on somebody's phone.
   *
   * The delta is broadcast either way. A rule this host states is not a reason to withhold a
   * step from a client that may render it perfectly well — `bb` validates for the same reason
   * and keeps the timeline moving. Absent means no checking at all, for tests that build a hub
   * without one.
   */
  onGrammarViolation?: (paneId: string, violation: GrammarViolation) => void;
}



/**
 * One WebSocket per device carrying every push-shaped event (ADR-10).
 *
 * Cell output is the reason subscriptions exist: a phone tails one cell at a
 * time, so forwarding every pane's PTY traffic to every connection would spend
 * the operator's battery on output nobody is looking at.
 */
export class StreamHub {
  private readonly connections = new Set<StreamConnection>();
  private resumeHandler: ((req: ResumeRequest, conn: StreamConnection) => void) | null = null;
  /** The recent deltas per cell, so a reconnecting client can be caught up. */
  private readonly deltas = new ConversationDeltaLog();
  /** What a producer is allowed to say, checked as it says it (`conversation/grammar.ts`). */
  private readonly grammar = new ConversationGrammar();
  private readonly conversationListeners = new Set<ConversationListener>();

  constructor(private readonly deps: StreamHubDeps) {}

  attach(socket: StreamSocket, device: Device): StreamConnection {
    const conn: StreamConnection = { device, socket, paneId: null };
    this.connections.add(conn);
    this.emit(conn, {
      type: "hello",
      hostId: this.deps.host.hostId,
      hostLabel: this.deps.host.hostLabel,
      mode: this.deps.host.mode,
      hostCaps: this.hostCaps(),
    });
    return conn;
  }

  detach(conn: StreamConnection): void {
    this.connections.delete(conn);
  }

  /** Panes at least one connection is tailing — what the output producer polls. */
  subscribedPanes(): string[] {
    const panes = new Set<string>();
    for (const conn of this.connections) {
      if (conn.paneId !== null) panes.add(conn.paneId);
    }
    return [...panes];
  }

  /** Applies an inbound frame. Malformed frames are dropped, never fatal. */
  handleMessage(conn: StreamConnection, raw: string): void {
    const msg = parseClientMessage(raw);
    if (msg === null) return;

    switch (msg.type) {
      case "subscribe":
        conn.paneId = msg.paneId;
        return;
      case "resume":
        this.resumeHandler?.({ paneId: msg.paneId, fromByte: msg.fromByte }, conn);
        return;
      case "conversation.resume":
        this.resumeConversations(msg.cursors, conn);
        return;
      case "ping":
        // Liveness only. The transport's own pong handles keep-alive.
        return;
    }
  }

  /** Registers the callback that serves ring-buffer backfill for a resume. */
  onResume(handler: (req: ResumeRequest, conn: StreamConnection) => void): void {
    this.resumeHandler = handler;
  }

  publishFleet(cells: FleetMember[]): void {
    // The resume log is pruned here rather than by the caller: this method already sees every
    // fleet snapshot, and a cache whose owner has to be reminded to trim it is one that grows
    // for the life of the process the first time somebody forgets.
    const alive = new Set(cells.map((c) => c.paneId));
    this.deltas.retain(alive);
    this.grammar.retain(alive);
    this.broadcast({ type: "fleet.changed", cells });
  }

  publishNotification(event: NotificationEvent): void {
    this.broadcast({ type: "notification", event });
  }

  /**
   * One conversation delta, broadcast like a notification rather than sent to subscribers.
   *
   * Deliberately not gated on `subscribe` the way `cell.output` is: a phone follows several
   * neighbouring cells at once so a swipe lands on a page that is already current
   * (`live_transcript.dart`), and a delta is a few hundred bytes where PTY output is a
   * stream.
   */
  publishConversation(paneId: string, agentType: string, update: ConversationUpdate): void {
    if (this.deps.onGrammarViolation !== undefined) {
      const broken = this.grammar.observe(paneId, update);
      if (broken !== undefined) this.deps.onGrammarViolation(paneId, broken);
    }
    // Recorded before it is sent, so a client that reconnects a millisecond later can still
    // ask for it. The cursor the log hands back is what makes the lane resumable at all.
    const cursor = this.deltas.append(paneId, agentType, update);
    this.broadcast({ type: "conversation", paneId, agentType, update, cursor });
    for (const listener of this.conversationListeners) {
      // Another transport (`/v1` SSE); one that throws must not stop the phone's lane.
      try {
        listener(paneId, agentType, update, cursor);
      } catch {
        /* the listener's own transport reports its failure */
      }
    }
  }

  /** Every conversation delta as it is logged, for a lane that is not a phone socket. */
  onConversation(listener: ConversationListener): () => void {
    this.conversationListeners.add(listener);
    return () => this.conversationListeners.delete(listener);
  }

  /** The same resume answer a phone gets, for a lane that is not a phone socket. */
  conversationSince(paneId: string, cursor: number): DeltasSince {
    return this.deltas.since(paneId, cursor);
  }

  /**
   * Replays what one connection missed, per cell it follows.
   *
   * Sent to that connection alone: a reconnect is one device catching up, and broadcasting the
   * backfill would replay another phone's history onto it. A cell whose cursor fell off the
   * ring gets `conversation.truncated` instead — one REST fetch repairs it, where a silent
   * partial replay would leave the transcript missing its middle.
   */
  resumeConversations(
    cursors: ReadonlyArray<{ paneId: string; cursor: number }>,
    conn: StreamConnection,
  ): void {
    for (const { paneId, cursor } of cursors) {
      const answer = this.deltas.since(paneId, cursor);
      if (answer.truncated) {
        this.emit(conn, {
          type: "conversation.truncated",
          paneId,
          requestedFromCursor: cursor,
          oldestCursor: answer.oldestCursor,
        });
        continue;
      }
      for (const delta of answer.deltas) {
        this.emit(conn, {
          type: "conversation",
          paneId,
          agentType: delta.agentType,
          update: delta.update,
          cursor: delta.cursor,
        });
      }
    }
  }

  /** How many cells the resume log holds — for a diagnostic, not for a caller to act on. */
  conversationLogSize(): number {
    return this.deltas.size();
  }

  /** Delivers PTY output to the connections tailing `paneId` and nobody else. */
  publishOutput(paneId: string, chunk: string, byteOffset: number): void {
    for (const conn of this.connections) {
      if (conn.paneId === paneId) {
        this.emit(conn, { type: "cell.output", paneId, chunk, byteOffset });
      }
    }
  }

  publishTruncated(paneId: string, requestedFromByte: number, servedFromByte: number): void {
    for (const conn of this.connections) {
      if (conn.paneId === paneId) {
        this.emit(conn, { type: "cell.truncated", paneId, requestedFromByte, servedFromByte });
      }
    }
  }

  sendToDevice(deviceId: string, event: ServerEvent): void {
    for (const conn of this.connections) {
      if (conn.device.deviceId === deviceId) this.emit(conn, event);
    }
  }

  /** Panes with at least one watcher — lets the caller stop unwatched streams. */
  watchedPanes(): string[] {
    const panes = new Set<string>();
    for (const conn of this.connections) {
      if (conn.paneId !== null) panes.add(conn.paneId);
    }
    return [...panes];
  }

  /** Devices with a socket tailing `paneId` — the phones already looking at it. */
  devicesViewing(paneId: string): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const conn of this.connections) {
      if (conn.paneId === paneId) ids.add(conn.device.deviceId);
    }
    return ids;
  }

  connectionCount(): number {
    return this.connections.size;
  }

  closeAll(): void {
    for (const conn of this.connections) conn.socket.close(1001, "Host shutting down");
    this.connections.clear();
  }

  private broadcast(event: ServerEvent): void {
    for (const conn of this.connections) this.emit(conn, event);
  }

  private emit(conn: StreamConnection, event: ServerEvent): void {
    conn.socket.send(JSON.stringify(event));
  }

  private hostCaps(): HostCaps {
    return {
      protocol: MOBILE_PROTOCOL_VERSION,
      features: hostFeatures(this.deps.host.mode, {
        push: this.deps.pushEnabled === true,
        structuredSpawn: this.deps.structuredSpawn === true,
        hooks: this.deps.hooks === true,
        projectsCreate: this.deps.projectsCreate === true,
        projectsBrowse: this.deps.projectsBrowse === true,
      }),
    };
  }
}
