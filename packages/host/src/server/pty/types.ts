import type { BridgeProvider } from "../../types/index.js";

export interface PtySessionState {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  /** "running" until the process exits, then "exited". */
  status: "running" | "exited";
  provider?: BridgeProvider;
  /**
   * The runner's own name when it differs from its family — the account behind
   * `ccs:initech`. `provider` is what a client routes on; this is what an operator reads
   * (`types/fleet.ts` keeps the two apart, and says why).
   */
  runnerLabel?: string;
  workspaceId?: string;
  title?: string;
  lastOutputAt?: number;
  /**
   * The posture this cell was launched with, kept because ADR-8 fixes it for the cell's
   * life and `toFleetMember` has to report it minutes later, to a phone that will draw a
   * permission knob from the answer.
   */
  permissionMode?: string;
}

export interface PtySessionMetadata {
  provider?: BridgeProvider;
  runnerLabel?: string;
  workspaceId?: string;
  title?: string;
  permissionMode?: string;
}
