import os from "os";
import path from "path";

export function lotusStateDir() {
  if (process.env.LOTUS_STATE_DIR) return process.env.LOTUS_STATE_DIR;
  const profileDir = process.env.NODE_ENV === "production" ? ".lotus" : ".lotus-dev";
  return path.join(os.homedir(), profileDir);
}

export function lotusTeamsDir() {
  return path.join(lotusStateDir(), "teams");
}

export function lotusTasksDir(teamId: string) {
  return path.join(lotusStateDir(), "tasks", teamId);
}

export function lotusLogsDir() {
  return path.join(lotusStateDir(), "agent-teams-logs");
}

export function lotusProcsFile() {
  return path.join(lotusStateDir(), "agent-teams-procs.json");
}
