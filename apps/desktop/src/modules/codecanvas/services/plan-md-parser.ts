export interface PlanStep {
  title: string;
  /** Agent name that owns this step (for live status). */
  owner?: string;
  /** Manual completion (overridden by the owner agent's live status when present). */
  done?: boolean;
}

const TASK_RE = /^\s*[-*]\s*\[( |x|X)\]\s+(.*\S)\s*$/;
const OWNER_PAREN_RE = /\s*\(owner:\s*([^)]+)\)\s*$/i;
const OWNER_AT_RE = /\s*@([A-Za-z0-9_-]+)\s*$/;

// Canonical description of the format `parsePlanMarkdown` reads, injected into agent run prompts so
// the plan a Lead writes is actually parseable by the canvas. Co-located with the parser on purpose:
// the example lines below are exercised by plan-md-parser.test.ts, so the two cannot drift apart.
export const PLAN_MD_FORMAT_INSTRUCTION = `# Plan output contract
If you produce a plan or break work into steps, write it to \`docs/agent-team/plan.md\`. The canvas Plan node reads ONLY GitHub-style checklist lines, so the file MUST contain a "## Steps" section where each step is its own line of the form \`- [ ] task (owner: Name)\`.
Rules: one step per line; begin each with \`- [ ]\` (or \`- [x]\` when already done); name the owner with \`(owner: Exact Teammate Name)\` — use the teammate's exact name (names with spaces or slashes require this form, never @handle). Prose and headings may surround the list; only the checklist lines are parsed. Example:
- [ ] Define the card data model and in-memory store (owner: Software Architect)
- [ ] Render the card list from the store (owner: Frontend Engineer)
- [x] Scaffold the project folder (owner: Backend Engineer)`;

/** Parses a markdown checkbox task list (e.g. docs/agent-team/plan.md) into plan steps. */
export function parsePlanMarkdown(content: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const line of content.split("\n")) {
    const match = TASK_RE.exec(line);
    if (!match) continue;
    const done = match[1].toLowerCase() === "x";
    let title = match[2];
    let owner: string | undefined;
    const paren = OWNER_PAREN_RE.exec(title);
    if (paren) {
      owner = paren[1].trim();
      title = title.slice(0, paren.index).trimEnd();
    } else {
      const at = OWNER_AT_RE.exec(title);
      if (at) {
        owner = at[1];
        title = title.slice(0, at.index).trimEnd();
      }
    }
    steps.push(owner ? { title, owner, done } : { title, done });
  }
  return steps;
}
