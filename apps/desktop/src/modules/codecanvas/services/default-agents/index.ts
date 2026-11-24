import type { AgentDefinition } from "../../types/canvas";
import { BUILD_TEAM, CODER, PLANNER, ARCHITECT, REVIEWER, QA, DEVOPS, TECHNICAL_WRITER } from "./build-team";
import { SPECIALISTS, RESEARCHER, CRITIC } from "./specialists";

/**
 * The fifteen built-in Agent Definitions, one per shipped avatar. Each is standalone-but-composable
 * (ADR 0010): a self-contained specialist whose coordination rides injected context, not its prompt.
 * Stable ids (`agent-<slug>`) make seeding idempotent -- re-loading upserts instead of duplicating.
 */
export const DEFAULT_AGENTS: AgentDefinition[] = [...BUILD_TEAM, ...SPECIALISTS];

/** The Coder definition powers Task "single" mode dispatch (one full-stack implementer, end to end). */
export const coderDefinition = CODER;

/**
 * Feature delivery pipeline: the five-agent sequence that takes a requirement from research through
 * shipping. Ordered by execution phase -- each handoff feeds the next stage.
 *
 * Requirement Intake
 *   -> Researcher  [grill-with-docs]
 *   -> Planner     [challenge assumptions]
 *   -> Critic      [devil's advocate / PASS-FAIL gate]
 *   -> (Human Clarification + Approval)
 *   -> Coder       [tdd, diagnose, simplify]
 *   -> Reviewer    [security-review, code-review]
 *   -> (Human Approval)
 *   -> Done
 */
export const FEATURE_PIPELINE: AgentDefinition[] = [
  RESEARCHER,
  PLANNER,
  CRITIC,
  CODER,
  REVIEWER,
];

/** Full engineering team for multi-specialist task dispatch. */
export const ENGINEERING_TEAM: AgentDefinition[] = [
  PLANNER,
  ARCHITECT,
  CODER,
  REVIEWER,
  QA,
  DEVOPS,
  TECHNICAL_WRITER,
];
