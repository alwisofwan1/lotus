// What the composer shows while the agent waits on the user: a tool permission or a question.
// Mockup: mockups/lotus-chat.fig, page "04b Approvals" (#276). Pure; read from thread state only.

import type { Interaction } from "./thread-event";
import type { InteractionState, ThreadState } from "./thread-state";
import { displayPath } from "./timeline";

/** Sent with Deny when the user typed no note. */
export const DENIED_WITHOUT_NOTE = "The user denied this.";
/** Sent when the user skips a question. */
export const SKIPPED_QUESTION = "The user skipped the question.";

const SHOWN_LINES = 12;

/** Unresolved requests of the running turn, oldest first. A turn that ends drops its requests. */
export function waitingRequests(state: ThreadState | null): InteractionState[] {
  const turn = state?.turns.at(-1);
  if (!state || state.session.ended || turn?.status !== "running") return [];
  return state.interactions.filter((i) => !i.resolution && (i.turnId === null || i.turnId === turn.id));
}

const TOOL_TITLES: Record<string, string> = {
  Bash: "Run a command?",
  Edit: "Edit a file?",
  MultiEdit: "Edit a file?",
  NotebookEdit: "Edit a file?",
  Write: "Create a file?",
  Read: "Read a file?",
  Grep: "Search files?",
  Glob: "Search files?",
  WebFetch: "Open a web page?",
  WebSearch: "Search the web?",
  ExitPlanMode: "Start building?",
};

export function requestTitle(interaction: Interaction): string {
  if (interaction.kind === "question") return interaction.questions[0]?.header || "A question";
  const title = TOOL_TITLES[interaction.toolName] ?? `Use ${interaction.toolName}?`;
  return interaction.blockedPath ? title.replace(/\?$/, " outside the folder?") : title;
}

export interface RequestDetail {
  /** The command, path or URL the tool will use. */
  target: string | null;
  /** Diff lines for an edit, first lines for a new file. */
  lines: Array<{ sign: " " | "+" | "-"; text: string }>;
  /** The agent's own reason, when it gave one. */
  note: string | null;
}

export function requestDetail(interaction: Extract<Interaction, { kind: "toolPermission" }>, cwd: string | null): RequestDetail {
  const input = (typeof interaction.input === "object" && interaction.input ? interaction.input : {}) as Record<string, unknown>;
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  const path = str("file_path") ?? str("notebook_path");
  const lines = (text: string | null, sign: " " | "+" | "-") =>
    (text ?? "").split("\n").map((line) => ({ sign, text: line }));
  switch (interaction.toolName) {
    case "Bash":
      return { target: str("command"), lines: [], note: str("description") };
    case "Edit":
      if (path) {
        // Codex (#286) sends a unified diff instead of old and new strings.
        const unified = str("diff");
        const diff = unified
          ? unified
              .replace(/\n$/, "")
              .split("\n")
              .filter((line) => !/^(@@|--- |\+\+\+ |diff |index )/.test(line))
              .map((line) => ({ sign: (line[0] === "+" || line[0] === "-" ? line[0] : " ") as " " | "+" | "-", text: line.slice(1) }))
          : [...lines(str("old_string"), "-"), ...lines(str("new_string"), "+")];
        return { target: displayPath(path, cwd), lines: diff.slice(0, SHOWN_LINES), note: null };
      }
      break;
    case "Write":
      if (path) {
        const content = (str("content") ?? str("diff") ?? "").replace(/\n$/, "");
        const all = lines(content, " ");
        return { target: `${displayPath(path, cwd)} · ${all.length} line${all.length === 1 ? "" : "s"}`, lines: all.slice(0, SHOWN_LINES), note: null };
      }
      break;
  }
  const target = path ? displayPath(path, cwd) : (str("pattern") ?? str("url") ?? str("query") ?? JSON.stringify(interaction.input));
  return { target, lines: [], note: null };
}

/** ExitPlanMode's plan (Markdown), so the card can show it instead of raw JSON; null for any other tool. */
export function planOf(interaction: Extract<Interaction, { kind: "toolPermission" }>): string | null {
  if (interaction.toolName !== "ExitPlanMode") return null;
  const plan = (interaction.input as { plan?: unknown } | null)?.plan;
  return typeof plan === "string" && plan.trim() ? plan : null;
}

/** The one line a decided request leaves in the timeline. */
export function decisionRecord(interaction: Interaction, resolution: NonNullable<InteractionState["resolution"]>): string {
  const { decision, message, answers } = resolution;
  if (decision === "allowed") return "Allowed";
  if (decision === "answered") {
    const header = interaction.kind === "question" ? interaction.questions[0]?.header : null;
    const answer = Object.values(answers ?? {}).join(" / ");
    return ["Answered", [header, answer].filter(Boolean).join(" · ")].filter(Boolean).join(" ");
  }
  if (interaction.kind === "question") return message && message !== SKIPPED_QUESTION ? `Skipped — “${message}”` : "Skipped";
  return message && message !== DENIED_WITHOUT_NOTE ? `Denied — “${message}”` : "Denied";
}

export interface QuestionChange {
  key: string;
  /** Null for a "no change" row: `to` then holds the agent's words. */
  from: string | null;
  to: string;
}

export interface QuestionParts {
  ask: string;
  changes: QuestionChange[];
  /** Text after the list, shown as a quiet line. */
  rest: string;
}

const BULLET = /^[•*-]\s+/;
const CHANGE = /^([^:→\n]{1,40}):\s*(.+?)\s*(?:→|->)\s*(.+)$/;
const SAME = /^([^:→\n]{1,40}):\s*(no change\b.*)$/i;

/**
 * Splits an agent question like "Set these? • Status: A → B • Repos: no change" into the ask, a
 * change list and the text after it. No "Key: old → new" line right after the ask → the whole text
 * comes back as `ask`, so nothing is ever lost.
 * shortcut: in the inline " • " form, prose after the last bullet stays glued to it; agents mostly send newlines.
 */
export function splitQuestion(text: string): QuestionParts {
  const parts = text.split(/\n+|\s+•\s+/).map((part) => part.trim()).filter(Boolean);
  const changes: QuestionChange[] = [];
  let i = 1;
  for (; i < parts.length; i++) {
    const line = parts[i].replace(BULLET, "");
    const same = SAME.exec(line);
    const change = same ? null : CHANGE.exec(line);
    if (same) changes.push({ key: same[1].trim(), from: null, to: same[2] });
    else if (change) changes.push({ key: change[1].trim(), from: change[2], to: change[3] });
    else break;
  }
  if (changes.length === 0) return { ask: text.trim(), changes: [], rest: "" };
  return { ask: parts[0], changes, rest: parts.slice(i).join("\n") };
}

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** "Yes (Recommended)" → { label: "Yes", recommended: true }. */
export function optionLabel(label: string): { label: string; recommended: boolean } {
  return RECOMMENDED.test(label) ? { label: label.replace(RECOMMENDED, ""), recommended: true } : { label, recommended: false };
}
