// Codex as a [`ProviderBridgeFactory`]: the posture expansion, the binary probe, and the option
// shape `codex app-server` takes — everything the store above the seam must not know.
import type {
  ProviderBridgeFactory,
  ProviderBridgeSession,
  ProviderBridgeSpawn,
} from "../../../../types/provider-bridge.js";
import { CodexAppServerSession, type CodexSessionOptions } from "../../codex-app-server/session.js";
import { onPath } from "./on-path.js";

/**
 * One stop on Codex's scale as the two axes `thread/start` takes (`approvalPolicy`, `sandbox`;
 * there is no `--permission-mode`). Legacy `safe`/`yolo` keep their approval-only meaning for
 * un-updated phones. An unknown mode lands on *ask*, never *run free*.
 */
export function codexPosture(mode: string | undefined): {
  approvalPolicy: CodexSessionOptions["approvalPolicy"];
  sandbox: CodexSessionOptions["sandbox"];
} {
  switch (mode) {
    case "read-only":
      return { approvalPolicy: "on-request", sandbox: "read-only" };
    case "full-access":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "yolo":
      return { approvalPolicy: "never", sandbox: "workspace-write" };
    default:
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
}

/** Whether `codex` can be spawned. */
export function codexOnPath(env?: NodeJS.ProcessEnv): boolean {
  return onPath("codex", env);
}

/** Swappable so a test never spawns a binary. */
export type CreateCodexSession = (opts: CodexSessionOptions) => ProviderBridgeSession;

export function codexBridge(createSession?: CreateCodexSession): ProviderBridgeFactory {
  const create = createSession ?? ((o: CodexSessionOptions) => new CodexAppServerSession(o));
  return {
    agentType: "codex",
    runnerLabel: "Codex",
    available: (env) => codexOnPath(env),
    gating: (mode) => (codexPosture(mode).approvalPolicy === "never" ? "skipped" : "asks"),
    create: (spawn: ProviderBridgeSpawn) =>
      create({
        paneId: spawn.paneId,
        cwd: spawn.cwd,
        ...codexPosture(spawn.permissionMode),
        ...(spawn.model === undefined ? {} : { model: spawn.model }),
        ...(spawn.effort === undefined ? {} : { effort: spawn.effort }),
        ...(spawn.resume === undefined ? {} : { resumeThreadId: spawn.resume }),
      }),
  };
}
