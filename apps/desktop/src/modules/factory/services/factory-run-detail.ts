import type { GraphRunStartInput } from "@/lib/tauri/graph-run";
import { DEFAULT_CAP_USD, factoryPrLabel, factoryPrOpening, factoryStartInput, factoryTicketRef, openIntakeTurn, triageBlock } from "./factory-run";
import type { FactoryRunRow } from "./factory-run-list";
import { FACTORY_WAITING_SENTENCE, factoryProgressLine } from "./factory-progress";

/**
 * What the detail pane says about one run, and what it lets you do. Each state has at most one
 * primary action — the one filled button — so the next step is never a choice to puzzle over.
 */

export type FactoryAction = "try-again" | "review-pr" | "raise-cap" | "abort";

export interface FactoryRunDetail {
  statusWord: string;
  /** One sentence: what happened, and what it waits for. */
  sentence: string;
  primary: FactoryAction | null;
  /** Shown as icon buttons beside the title. */
  secondary: FactoryAction[];
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** What the words depend on: a list row has it, and so does one issue's run view. */
export type FactoryRunFacts = Pick<FactoryRunRow, "state" | "spentUsd" | "capUsd" | "output" | "prUrl" | "progress" | "intake">;

/** The agent's reason as one sentence of ours: trimmed, ending in a full stop. */
function sentenceOf(reason: string | undefined): string {
  const text = reason?.trim() ?? "";
  if (!text) return "It gave no reason.";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function factoryRunDetail(row: FactoryRunFacts): FactoryRunDetail {
  switch (row.state) {
    case "running":
      return { statusWord: "Working", sentence: factoryProgressLine(row.progress) ?? FACTORY_WAITING_SENTENCE, primary: null, secondary: ["abort"] };
    case "recovery-required":
      return { statusWord: "Recovery required", sentence: row.output || "The app stopped before this run finished. Automatic resume is disabled until its artifacts can be inspected safely.", primary: null, secondary: ["abort"] };
    case "paused": {
      const spend = row.spentUsd !== null && row.capUsd !== null ? ` (${usd(row.spentUsd)} of ${usd(row.capUsd)})` : "";
      return {
        statusWord: "Needs you",
        sentence: `Paused at the cost cap${spend}. Raise the cap to let it finish.`,
        primary: "raise-cap",
        secondary: ["abort"],
      };
    }
    case "needs-answers": {
      const turn = openIntakeTurn(row.intake);
      const count = turn?.kind === "asked" ? turn.questions.length : 0;
      return {
        statusWord: "Needs you",
        sentence: `The spec agent read the code and has ${count === 1 ? "1 question" : `${count || "some"} questions`}. Answer to let it write the spec.`,
        primary: null,
        secondary: ["abort"],
      };
    }
    case "triage-blocked": {
      const triage = row.intake?.triage;
      const block = triageBlock(triage);
      const sentence =
        block === "duplicates"
          ? "Work on this issue already exists. Check it, then continue anyway or abort this run."
          : block === "multi-repo"
            ? `Multi-repo is not supported yet: this change needs ${(triage?.report?.repos ?? []).join(" and ")}, and a run builds in one sub-repo. Abort this run and split the ticket.`
            : `Triage advises not to build this ticket. ${sentenceOf(triage?.report?.reason)} Continue anyway or abort.`;
      return { statusWord: "Needs you", sentence, primary: null, secondary: ["abort"] };
    }
    case "needs-approval":
      return {
        statusWord: "Needs you",
        sentence: "The spec is ready. Approve it to start the build, or send it back with what to change.",
        primary: null,
        secondary: ["abort"],
      };
    case "check-failed":
      return { statusWord: "Needs you", sentence: "The check failed after the last try. Read why, then try again.", primary: "try-again", secondary: [] };
    case "error":
      return {
        statusWord: "Needs you",
        sentence: row.output ? `The run stopped with an error: ${row.output}` : "The run stopped with an error.",
        primary: "try-again",
        secondary: [],
      };
    case "done": {
      const prOpen = factoryPrOpening(row.progress);
      return {
        statusWord: "Ready to review",
        sentence: prOpen.draft
          ? `A draft PR is open.${prOpen.reason ? ` Why a draft: ${prOpen.reason}` : ""} The merge is yours.`
          : "The review accepted it and the PR is open. The merge is yours.",
        primary: row.prUrl ? "review-pr" : null,
        secondary: [],
      };
    }
    case "merged":
      return {
        statusWord: "Done",
        sentence: `${factoryPrLabel(row.prUrl) ?? "The PR"} merged. Nothing is left to do.`,
        primary: null,
        secondary: [],
      };
    case "pr-closed":
      return {
        statusWord: "Stopped",
        sentence: `${factoryPrLabel(row.prUrl) ?? "The draft PR"} was closed without a merge. Try again to make a new one.`,
        primary: "try-again",
        secondary: [],
      };
    case "stopped":
    case "idle":
      return { statusWord: "Stopped", sentence: "This run was stopped before it finished.", primary: "try-again", secondary: [] };
  }
}

const FAILING = /\bfail(ed|ure|ing)?\b|\berror\b|✗|×|panicked|assert/i;

/** The lines of a gate's output that say what failed; the last lines when none do. */
export function failingLines(output: string | null, max = 8): string[] {
  const lines = (output ?? "").split("\n").filter((line) => line.trim() !== "");
  const failing = lines.filter((line) => FAILING.test(line));
  return (failing.length > 0 ? failing : lines.slice(-max)).slice(0, max);
}

/**
 * Start the same issue again: same project, agent and cap. `fresh` is the issue as GitHub has it
 * now — it may have been edited since — and the stored copy is used only when it cannot be read.
 * A run that stopped with output passes it on, so the new run does not repeat it.
 */
export function factoryRetryInput(row: FactoryRunRow, fresh?: { title: string; body: string | null } | null): GraphRunStartInput {
  const { ticket } = row;
  const failed = (row.state === "check-failed" || row.state === "error") && row.output?.trim() ? row.output : undefined;
  return factoryStartInput({
    projectId: row.projectId,
    repo: ticket.repo,
    issue: { number: factoryTicketRef(ticket), title: fresh?.title ?? ticket.title, body: fresh ? fresh.body : ticket.body },
    ...(ticket.notion ? { notion: { pageId: ticket.notion.pageId, url: ticket.notion.url } } : {}),
    account: ticket.account,
    checkout: ticket.checkout,
    implementer: ticket.implementer,
    budgetCap: row.capUsd ?? DEFAULT_CAP_USD,
    ...(failed ? { previousFailure: failed } : {}),
  });
}
