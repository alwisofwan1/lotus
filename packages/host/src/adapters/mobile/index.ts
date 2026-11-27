import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";
import { StreamHeartbeat } from "./stream-heartbeat.js";
import { serveStreamSockets } from "./stream-attach.js";

import type { ConversationPage } from "../../types/conversation.js";
import type { ChatActionResult, ConversationListener } from "../../types/conversation.js";
import { chatActions } from "./chat-actions.js";
import type { DeltasSince } from "./conversation/delta-log.js";
import type { FleetMember, RemoteAdapter } from "../../types/index.js";
import { buildAdminRouter } from "./admin-routes.js";
import { listenOrWarn } from "./bind-diagnosis.js";
import { AdminServer } from "./admin-server.js";
import { reportGrammarViolation } from "./conversation/grammar.js";
import { StepPublisher, transcriptEntriesOf } from "./conversation/step-publisher.js";
import { DeviceStore } from "./device-store.js";
import { buildMobileRouter, type MobileHostIdentity } from "./http-routes.js";
import { PairingService } from "./pairing.js";
import { OutputTail } from "./output-tail.js";
import { pushServiceOrNull, type PushService } from "./push/push-service.js";
import { NotificationRelay } from "./notification-relay.js";
import { StreamHub } from "./stream-hub.js";
import { BridgeRegistry } from "./structured/bridge-registry.js";
import { CellBook } from "./structured/cell-book.js";
import { StructuredSessions } from "./structured/structured-sessions.js";
import type { MobileAdapterOptions } from "./adapter-options.js";
import { ChatAttachmentStore } from "../../core/chat-attachments.js";

export type { MobileAdapterOptions } from "./adapter-options.js";

/** Interval between fleet snapshots pushed to connected devices. */
const FLEET_POLL_MS = 3_000;

/**
 * The `/m/*` façade: one WebSocket per device for push, HTTP for mutations.
 *
 * This is the only network-facing listener in the host. The Rust API it proxies
 * stays bound to localhost (ADR-3), which is why device tokens, the audit trail
 * and rate limiting all live here rather than there.
 */
export class MobileAdapter implements RemoteAdapter {
  readonly name = "mobile";

  private readonly devices: DeviceStore;
  private readonly pairing: PairingService;
  private readonly hub: StreamHub;
  private server: Server | null = null;
  private admin: AdminServer | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: StreamHeartbeat | null = null;
  private fleetTimer: ReturnType<typeof setInterval> | null = null;
  private lastFleetJson = "";

  /** Last snapshot pushed: `pushFleet` dedupes process-wide, so a phone attaching mid-session got silence. */
  private lastFleet: FleetMember[] = [];

  private outputTail: OutputTail | null = null;
  /** Agents this host runs itself over `codex app-server` — absent when the binary is not on PATH. */
  private readonly structured: StructuredSessions | null;
  private restored = false;

  /** What `GET /m/bootstrap` already merges for the phone, for `POST /v1/list-fleet` too. */
  structuredFleet(workspaceId?: string): FleetMember[] {
    return this.structured?.list(workspaceId) ?? [];
  }
  /** False until the last run's cells are back (never, when another host still holds the port and them). */
  structuredReady(): boolean {
    return this.structured === null || this.restored;
  }
  structuredPage(paneId: string): ConversationPage | undefined {
    return this.structured?.page(paneId);
  }
  conversationSince(paneId: string, cursor: number): DeltasSince {
    return this.hub.conversationSince(paneId, cursor);
  }
  onConversation(listener: ConversationListener): () => void {
    return this.hub.onConversation(listener);
  }
  chatAct(action: string, body: Record<string, unknown>): Promise<ChatActionResult> {
    if (this.structured === null) return Promise.resolve({ status: 400, body: { ok: false, error: "this host cannot run an agent without a terminal" } });
    const dir = this.opts.attachmentsDir;
    return chatActions({
      structured: this.structured,
      api: this.opts.api,
      onAsk: (p) => this.push?.recordAsk(p),
      ...(dir === undefined ? {} : { attachments: new ChatAttachmentStore(dir) }),
    })(action, body);
  }
  private readonly notifications: NotificationRelay;
  /** Hook entries, converted to `Part` deltas so both lanes carry every step. */
  private readonly steps: StepPublisher;
  private readonly push: PushService | null;

  constructor(private readonly opts: MobileAdapterOptions) {
    this.devices = new DeviceStore(opts.devicesPath);
    this.pairing = new PairingService(this.devices);
    const bridges = new BridgeRegistry({ readableDir: opts.attachmentsDir });
    const structuredSpawn = opts.structuredSpawn ?? bridges.anyAvailable();
    this.hub = new StreamHub({
      host: opts.host,
      pushEnabled: opts.pushSender !== undefined,
      structuredSpawn,
      hooks: opts.hooks === true,
      projectsCreate: opts.projectsCreate === true,
      projectsBrowse: opts.projectsBrowse === true,
      // A producer that misbehaves against a real CLI is heard here rather than on a phone.
      onGrammarViolation: reportGrammarViolation((event, fields) => opts.logger.warn(event, fields)),
    });
    this.push = pushServiceOrNull({
      devices: this.devices,
      ...(opts.pushSender === undefined ? {} : { sender: opts.pushSender }),
      log: (message, fields) => opts.logger.info(message, fields),
      fleetSnapshot: () => this.fleet(),
      viewing: (paneId) => this.hub.devicesViewing(paneId),
    });
    this.structured = structuredSpawn
      ? new StructuredSessions({
          registry: bridges,
          ...(opts.structuredCellsPath === undefined ? {} : { book: new CellBook(opts.structuredCellsPath) }),
          publishNotification: (event) => {
            this.hub.publishNotification(event);
            void this.push?.notify(event);
          },
          publishConversation: (p, agent, u) => this.hub.publishConversation(p, agent, u),
          fleetChanged: () => void this.pushFleet(),
        })
      : null;
    this.steps = new StepPublisher({
      publishConversation: (p, a, u) => this.hub.publishConversation(p, a, u),
      isStructured: (id) => this.structured?.has(id) === true,
      entriesOf: transcriptEntriesOf(opts.api),
    });
    this.notifications = new NotificationRelay({
      api: opts.api,
      // Foreground and background from one source (ADR-4): the socket serves whoever is
      // connected, this serves whoever is not. `notify` contains its own failures, so an
      // FCM outage never breaks the live channel.
      onEvent: async (event) => {
        this.hub.publishNotification(event);
        this.steps.publish(event);
        await this.push?.notify(event);
      },
      warn: (message, fields) => opts.logger.warn(message, fields),
      sleep: opts.sleep,
    });
  }

  /** Issues a pairing code for the operator to scan or type. */
  createPairingCode(): { code: string; expiresAt: number } {
    return this.pairing.create();
  }

  /** Bound address once started — useful when the port was 0. */
  address(): { host: string; port: number } | null {
    const addr = this.server?.address();
    return addr !== null && typeof addr === "object"
      ? { host: (addr as AddressInfo).address, port: (addr as AddressInfo).port }
      : null;
  }

  async start(): Promise<void> {
    const router = buildMobileRouter({
      api: this.opts.api,
      devices: this.devices,
      pairing: this.pairing,
      host: this.opts.host,
      audit: (event, fields) => this.opts.logger.audit(event, fields),
      fleetSnapshot: () => this.fleet(),
      // Read at request time, so it does not matter that the tail is built after the
      // router: by the time a key can arrive, the adapter has started.
      onInput: (paneId) => this.outputTail?.quicken(paneId),
      onAsk: (paneId) => this.push?.recordAsk(paneId),
      pushEnabled: this.push !== null,
      projectsCreate: this.opts.projectsCreate === true,
      projectsBrowse: this.opts.projectsBrowse === true,
      hooks: this.opts.hooks === true,
      ...(this.structured === null ? {} : { structured: this.structured }),
    });

    const server = createServer((req, res) => {
      if (router.dispatch(req, res)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    });
    this.server = server;

    // The door to `/m/stream`, and the heartbeat that keeps what comes through it honest.
    const stream = serveStreamSockets(server, {
      devices: this.devices,
      hub: this.hub,
      lastFleet: () => this.lastFleet,
      audit: (event, fields) => this.opts.logger.audit(event, fields),
    });
    this.wss = stream.wss;
    this.heartbeat = stream.heartbeat;

    const bound = await listenOrWarn(server, this.opts.bind, (event, fields) => this.opts.logger.warn(event, fields));
    if (!bound) {
      // Not fatal, on purpose. An occupied port means no phone can reach this host —
      // it does not mean the host should stop running PTYs, MCP, or anything else.
      // Discovered on a live restart, where an orphaned runtime from the previous run
      // still held the port and the EADDRINUSE took the whole process down.
      this.server = null;
      await this.startAdmin();
      return;
    }

    await this.startAdmin();
    // Only once bound: a port still held by an older host means that host still runs these cells.
    void this.structured?.restore().finally(() => (this.restored = true));

    // The producer for `cell.output`, which nothing had ever called in production.
    const tail = new OutputTail({
      api: this.opts.api,
      hub: this.hub,
      subscribedPanes: () => this.hub.subscribedPanes(),
      onError: (paneId, error) =>
        this.opts.logger.warn("mobile.output.read_failed", { paneId, error: String(error) }),
      ...(this.opts.sessionHistoryDiagnostics === undefined ? {} : { diagnostics: this.opts.sessionHistoryDiagnostics }),
    });
    this.hub.onResume((req) => void tail.resume(req.paneId, req.fromByte));
    tail.start();
    this.outputTail = tail;

    this.notifications.start();

    this.fleetTimer = setInterval(() => void this.pushFleet(), this.opts.fleetPollMs ?? FLEET_POLL_MS);
    this.opts.logger.audit("host.start", { adapter: this.name, ...(this.address() ?? {}) });
  }

  async stop(): Promise<void> {
    const admin = this.admin;
    this.admin = null;
    await admin?.stop();

    if (this.fleetTimer !== null) clearInterval(this.fleetTimer);
    this.fleetTimer = null;
    this.outputTail?.stop();
    this.outputTail = null;
    this.notifications.stop();
    this.structured?.closeAll();
    this.hub.closeAll();
    this.heartbeat?.stop();
    this.heartbeat = null;
    this.wss?.close();
    this.wss = null;
    const server = this.server;
    this.server = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.opts.logger.audit("host.stop", { adapter: this.name });
  }

  /** Started after the façade so `/admin/health` can report its bound address. */
  private async startAdmin(): Promise<void> {
    const cfg = this.opts.admin;
    if (cfg === undefined) return;

    const admin = new AdminServer({
      router: buildAdminRouter({
        devices: this.devices,
        pairing: this.pairing,
        secret: cfg.secret,
        host: this.opts.host,
        mobileAddress: () => this.address(),
        audit: (event, fields) => this.opts.logger.audit(event, fields),
      }),
      secret: cfg.secret,
      advertPath: cfg.advertPath,
    });
    await admin.start();
    this.admin = admin;
  }

  /**
   * Forwards desktop notification events to every device.
   *
   * `needs-input` is the event this product exists for (job story #1), and until now it
   * reached the phone from nowhere: `publishNotification` had no caller outside tests.
   */
  private async fleet(): Promise<FleetMember[]> {
    const desktop = (await this.opts.api.listFleet({ pageSize: 100 })).items;
    return this.structured === null ? desktop : [...desktop, ...this.structured.list()];
  }

  /** Pushes the fleet only when it actually changed — idle devices stay idle. */
  private async pushFleet(): Promise<void> {
    if (this.hub.connectionCount() === 0) return;
    try {
      const cells = await this.fleet();
      const json = JSON.stringify(cells);
      // Remember it either way: the dedupe below decides whether to *broadcast*, but a
      // device attaching later still needs the current snapshot.
      this.lastFleet = cells;
      // A cell that is gone gains no more steps. The hub prunes its own resume log.
      this.steps.retain(new Set(cells.map((c) => c.paneId)));
      if (json === this.lastFleetJson) return;
      this.lastFleetJson = json;
      this.hub.publishFleet(cells);
    } catch (err) {
      this.opts.logger.warn("mobile.fleet.poll_failed", { error: String(err) });
    }
  }
}
