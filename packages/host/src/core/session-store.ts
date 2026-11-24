import { readFileSync } from "node:fs";

import { atomicWriteSync } from "./atomic-write.js";
import { SESSION_ATTACHMENT_TTL_MS } from "./constants.js";

interface PtyAttachment {
  sessionId: string;
  attachedAt: number;
}

interface FocusState {
  workspaceId: string;
  paneId?: string;
  setAt: number;
}

interface ProjectFocusState {
  projectId: string;
  path: string;
  setAt: number;
}

interface DeviceState {
  ptyAttachment?: PtyAttachment;
  focus?: FocusState;
  projectFocus?: ProjectFocusState;
  /** Last activity timestamp (ms since epoch) — used for TTL pruning. */
  lastActiveAt: number;
}

interface StoreData {
  /** Keyed by device id; field name stays `chats` so existing files keep loading. */
  chats: Record<string, DeviceState>;
}

/**
 * Legacy shape for migration only. Pre-Slice-6 stores attached PTY sessions
 * under `attachments`; new shape lifts that into `chats[id].ptyAttachment`
 * and adds focus + lastActiveAt.
 */
interface LegacyStoreData {
  attachments: Record<string, PtyAttachment>;
}

export interface FocusInfo {
  workspaceId: string;
  paneId?: string;
  setAt?: number;
}

export interface ProjectFocusInfo {
  projectId: string;
  path: string;
  setAt?: number;
}

/**
 * Persists per-device state — PTY attachment + focus (workspace/pane) — to a
 * JSON file so they survive host restarts. PTY attachments older than `ttlMs`
 * are pruned automatically; focus is sticky (operator clears explicitly).
 */
export class SessionStore {
  private data: StoreData = { chats: {} };

  constructor(
    private readonly filePath: string,
    private readonly ttlMs: number = SESSION_ATTACHMENT_TTL_MS,
  ) {
    this.load();
  }

  // ─── PTY attachment ────────────────────────────────────────────────────────

  attach(deviceId: string, sessionId: string): void {
    const device = this.upsertDevice(deviceId);
    device.ptyAttachment = { sessionId, attachedAt: Date.now() };
    this.save();
  }

  getAttachment(deviceId: string): string | null {
    const device = this.data.chats[deviceId];
    const att = device?.ptyAttachment;
    if (!att) return null;
    if (Date.now() - att.attachedAt > this.ttlMs) {
      this.detach(deviceId);
      return null;
    }
    return att.sessionId;
  }

  detach(deviceId: string): void {
    const device = this.data.chats[deviceId];
    if (!device) return;
    delete device.ptyAttachment;
    this.gcEmptyDevice(deviceId, device);
    this.save();
  }

  // ─── Focus (workspace + pane the operator is currently driving) ────────────

  setFocus(deviceId: string, workspaceId: string, paneId?: string): void {
    const device = this.upsertDevice(deviceId);
    device.focus = paneId !== undefined
      ? { workspaceId, paneId, setAt: Date.now() }
      : { workspaceId, setAt: Date.now() };
    this.save();
  }

  getFocus(deviceId: string): FocusInfo | null {
    const focus = this.data.chats[deviceId]?.focus;
    if (!focus) return null;
    return focus.paneId !== undefined
      ? { workspaceId: focus.workspaceId, paneId: focus.paneId, setAt: focus.setAt }
      : { workspaceId: focus.workspaceId, setAt: focus.setAt };
  }

  clearFocus(deviceId: string): void {
    const device = this.data.chats[deviceId];
    if (!device) return;
    delete device.focus;
    this.gcEmptyDevice(deviceId, device);
    this.save();
  }

  // ─── Project focus (HostedProject the operator is currently working in) ───

  setProjectFocus(deviceId: string, projectId: string, path: string): void {
    const device = this.upsertDevice(deviceId);
    device.projectFocus = { projectId, path, setAt: Date.now() };
    this.save();
  }

  getProjectFocus(deviceId: string): ProjectFocusInfo | null {
    const focus = this.data.chats[deviceId]?.projectFocus;
    if (!focus) return null;
    return { projectId: focus.projectId, path: focus.path, setAt: focus.setAt };
  }

  clearProjectFocus(deviceId: string): void {
    const device = this.data.chats[deviceId];
    if (!device) return;
    delete device.projectFocus;
    this.gcEmptyDevice(deviceId, device);
    this.save();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private upsertDevice(deviceId: string): DeviceState {
    let device = this.data.chats[deviceId];
    if (!device) {
      device = { lastActiveAt: Date.now() };
      this.data.chats[deviceId] = device;
    } else {
      device.lastActiveAt = Date.now();
    }
    return device;
  }

  /**
   * Drops a device entry that has neither attachment nor focus left to track —
   * keeps the store from accumulating empty per-device skeletons.
   */
  private gcEmptyDevice(deviceId: string, device: DeviceState): void {
    if (!device.ptyAttachment && !device.focus && !device.projectFocus) {
      delete this.data.chats[deviceId];
    }
  }

  private pruneStale(): void {
    const now = Date.now();
    for (const [key, device] of Object.entries(this.data.chats)) {
      if (device.ptyAttachment && now - device.ptyAttachment.attachedAt > this.ttlMs) {
        delete device.ptyAttachment;
      }
      this.gcEmptyDevice(key, device);
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreData> & Partial<LegacyStoreData>;
      this.data = isLegacyShape(parsed) ? migrateLegacy(parsed) : { chats: parsed.chats ?? {} };
      this.pruneStale();
    } catch {
      this.data = { chats: {} };
    }
  }

  private save(): void {
    atomicWriteSync(this.filePath, this.data);
  }
}

function isLegacyShape(
  data: Partial<StoreData> & Partial<LegacyStoreData>,
): data is LegacyStoreData {
  return data.chats === undefined && data.attachments !== undefined;
}

function migrateLegacy(legacy: LegacyStoreData): StoreData {
  const chats: Record<string, DeviceState> = {};
  for (const [key, attachment] of Object.entries(legacy.attachments)) {
    chats[key] = {
      ptyAttachment: attachment,
      lastActiveAt: attachment.attachedAt,
    };
  }
  return { chats };
}
