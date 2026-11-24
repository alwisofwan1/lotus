import { runnerCanResume, type AgentRunnerType } from "@/lib/agent-runtime";

/**
 * Can this runner continue a conversation, and is it allowed to?
 * (`plans/codecanvas-session-refactor/issues/01`.)
 */

export interface ResumeCapabilityConfig {
  resume_template?: string | null;
  claude_family?: boolean;
  resume_on_reopen?: boolean;
}

export type ResumeCapability =
  /** Has a mechanism, and the user permits it. */
  | { kind: "resume" }
  /** Has a mechanism, but `resume_on_reopen` is off in Settings → Runners. */
  | { kind: "off-by-setting" }
  /** This runner has no way to continue a conversation at all. */
  | { kind: "unsupported" };

export function resumeCapability(
  runner: AgentRunnerType,
  config?: ResumeCapabilityConfig | null,
): ResumeCapability {
  if (!runnerCanResume(runner, config)) return { kind: "unsupported" };
  // Absent means on: a runner detected before the toggle existed still resumes.
  if (config?.resume_on_reopen === false) return { kind: "off-by-setting" };
  return { kind: "resume" };
}
