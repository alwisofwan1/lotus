import type { Server } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import type { AuditEvent, Fields } from "../../core/logger.js";

import type { Device, DeviceStore } from "./device-store.js";
import type { FleetMember } from "../../types/fleet.js";
import type { StreamHub } from "./stream-hub.js";
import { StreamHeartbeat } from "./stream-heartbeat.js";

/**
 * What happens the moment a phone's `/m/stream` socket attaches: a revoked device is turned
 * away, a client gets the fleet as of NOW, and every socket is kept honest, since nothing
 * else tells a dead one from a quiet one (`issues/10`).
 */
export interface StreamAttachDeps {
  devices: Pick<DeviceStore, "list">;
  hub: StreamHub;
  heartbeat: StreamHeartbeat | null;
  /** The fleet as last seen, so a socket that arrives between changes is not left blank. */
  lastFleet: () => FleetMember[];
}

export function attachStreamSocket(ws: WebSocket, deviceId: string, deps: StreamAttachDeps): void {
  const device: Device | undefined = deps.devices.list().find((d) => d.deviceId === deviceId);
  if (device === undefined) {
    ws.close(1008, "Device is no longer paired");
    return;
  }

  const conn = deps.hub.attach(
    { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
    device,
  );

  // The fleet a client needs is the current one, not the next change.
  const fleet = deps.lastFleet();
  if (fleet.length > 0) {
    deps.hub.sendToDevice(device.deviceId, { type: "fleet.changed", cells: fleet });
  }

  // Answered automatically by every WebSocket client, so an already-installed phone build gets
  // this without being rebuilt.
  ws.on("pong", () => deps.heartbeat?.pong(ws));
  ws.on("message", (raw) => deps.hub.handleMessage(conn, raw.toString()));
  ws.on("close", () => deps.hub.detach(conn));
  ws.on("error", () => deps.hub.detach(conn));
}

/**
 * Who may open a `/m/stream` socket on [server], and what keeps open ones honest. Beside
 * {@link attachStreamSocket}: one is the door, the other what happens after. The bearer rides
 * in the query string because a browser cannot set a header on a WebSocket upgrade (ADR-10).
 */
export function serveStreamSockets(
  server: Server,
  deps: Omit<StreamAttachDeps, "heartbeat"> & {
    devices: DeviceStore;
    audit: (event: AuditEvent, fields?: Fields) => void;
  },
): { wss: WebSocketServer; heartbeat: StreamHeartbeat } {
  const wss = new WebSocketServer({ noServer: true });
  // Nothing else keeps these sockets honest. Without it a connection the network has silently
  // dropped is indistinguishable from an idle one, so this host writes frames nobody reads and
  // the phone never learns to reconnect (`issues/10`, reopened 2026-09-06).
  const heartbeat = new StreamHeartbeat(() => wss.clients);
  heartbeat.start();

  server.on("upgrade", (req, socket, head) => {
    const bearer = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
    const device = bearer === null ? null : deps.devices.verify(bearer);
    if (!device || !(req.url ?? "").startsWith("/m/stream")) {
      deps.audit("auth.rejected", { route: "/m/stream" });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      attachStreamSocket(ws, device.deviceId, { ...deps, heartbeat }));
  });

  return { wss, heartbeat };
}

