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
 * One stop on Codex's scale, expanded into the two axes `codex app-server` actually takes.
 *
 * **Codex has no `--permission-mode`.** `thread/start` takes an `approvalPolicy` and a
 * `sandbox` separately, so a single word from the phone has to become a pair here — which is
 * the whole reason the scale is advertised per runner rather than shared with Claude's.
 *
 * The two legacy values keep their exact meaning from before the scale existed, sandbox
 * included: `safe` and `yolo` only ever moved the approval axis, and widening what they mean
 * would change cells spawned by phones that have not been updated.
 *
 * An unrecognised mode lands on the asking default rather than being refused. The route has
 * already checked it against what this host advertises; arriving here with something else
 * means a newer phone knows a stop this host does not, and the safe reading of an unknown
 * posture is *ask*, never *run free*.
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
