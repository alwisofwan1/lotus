import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { atomicWriteSync } from "./atomic-write.js";
import type { BridgeProvider } from "../types/index.js";

export type WorkState =
  | "planning"
  | "awaiting-approval"
  | "implementing"
  | "testing"
  | "summarizing"
  | "complete"
  | "failed"
  | "aborted";

export interface WorkSession {
  id: string;
  deviceId: string;
  projectId: string;
  projectPath: string;
  provider: BridgeProvider;
  goal: string;
  state: WorkState;
  plan: string | null;
  ptySessionId: string | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  completedAt: number | null;
  summary: string | null;
  checkResult: string | null;
}

export interface CreateWorkSessionRequest {
  projectId: string;
  projectPath: string;
  provider: BridgeProvider;
  goal: string;
}

export type WorkSessionPatch = Partial<Pick<
  WorkSession,
  "state" | "plan" | "ptySessionId" | "approvedAt" | "completedAt" | "summary" | "checkResult"
>>;

interface StoreData {
  sessions: Record<string, WorkSession>;
  /** Was `activeByChat`; renamed with the shape, since WorkSession carries the id. */
  activeByDevice: Record<string, string>;
}

const TERMINAL_STATES: ReadonlySet<WorkState> = new Set(["complete", "failed", "aborted"]);

export class WorkStore {
  private data: StoreData = { sessions: {}, activeByDevice: {} };

  constructor(private readonly filePath: string) {
    this.load();
  }

  create(deviceId: string, req: CreateWorkSessionRequest): WorkSession {
    const now = Date.now();
    const session: WorkSession = {
      id: `work_${randomUUID()}`,
      deviceId,
      projectId: req.projectId,
      projectPath: req.projectPath,
      provider: req.provider,
      goal: req.goal,
      state: "planning",
      plan: null,
      ptySessionId: null,
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      completedAt: null,
      summary: null,
      checkResult: null,
    };

    this.data.sessions[session.id] = session;
    this.data.activeByDevice[deviceId] = session.id;
    this.save();
    return session;
  }

  get(id: string): WorkSession | null {
    return this.data.sessions[id] ?? null;
  }

  getActive(deviceId: string): WorkSession | null {
    const id = this.data.activeByDevice[deviceId];
    if (!id) return null;
    return this.get(id);
  }

  listActive(): WorkSession[] {
    return Object.values(this.data.activeByDevice)
      .map((id) => this.get(id))
      .filter((session): session is WorkSession => session !== null);
  }

  update(id: string, patch: WorkSessionPatch): WorkSession | null {
    const existing = this.data.sessions[id];
    if (!existing) return null;

    const now = Date.now();
    const next: WorkSession = {
      ...existing,
      ...patch,
      updatedAt: now,
    };
    if (patch.state && TERMINAL_STATES.has(patch.state) && next.completedAt === null) {
      next.completedAt = now;
    }

    this.data.sessions[id] = next;
    if (TERMINAL_STATES.has(next.state)) {
      delete this.data.activeByDevice[next.deviceId];
    } else {
      this.data.activeByDevice[next.deviceId] = id;
    }
    this.save();
    return next;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreData>;
      this.data = {
        sessions: parsed.sessions ?? {},
        activeByDevice: parsed.activeByDevice ?? {},
      };
    } catch {
      this.data = { sessions: {}, activeByDevice: {} };
    }
  }

  private save(): void {
    atomicWriteSync(this.filePath, this.data);
  }
}
