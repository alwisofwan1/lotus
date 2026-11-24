/**
 * Starting points, offered in Browse and under "New automation" (bb's AUTOMATION_CREATE_TEMPLATES).
 * Each one opens an agent with the request already written; the agent asks for what is missing
 * and saves the automation switched off.
 */

export type TemplateIcon = "slack" | "brief" | "digest" | "stale";

export type AutomationTemplate = {
  id: string;
  title: string;
  description: string;
  icon: TemplateIcon;
  /** What starts it, for Browse's filter: a Slack mention, or a schedule. */
  trigger: "slack" | "schedule";
  /** When it runs, in one short line. */
  when: string;
  /** What it makes, and where that goes, in one short line. */
  output: string;
  /** What the agent receives before the house instructions are appended. */
  request: string;
  /** An example of what it makes, shown in Browse's preview. Illustrative, never real data. */
  sample: string;
  /**
   * What the agent asks before it saves: what the request leaves open, and the summary fields it
   * confirms (agentPromptFor). It skips a question it can answer from Lotus's options.
   */
  asks: string[];
};

/** Every template's agent confirms these before it saves (see agentPromptFor). */
const CONFIRMS = ["Which GitHub account it reads or posts as", "Which agent preset runs it", "Which project it works in, if any"];

export const TEMPLATES: AutomationTemplate[] = [
  {
    id: "slack-review",
    title: "Review PRs asked for in Slack",
    description: "A mention of you or your team with a PR link drafts a review. You read it and press Send.",
    icon: "slack",
    trigger: "slack",
    when: "When someone mentions you or your team with a PR link",
    output: "A review draft in Inbox; posts only when you press Send",
    request:
      "Create a Lotus automation that drafts a review for each GitHub PR someone asks me to review in Slack. Ask me which channel, which repos, and which team counts as me.",
    sample: "A review draft for acme-api#2952 waits in Inbox:\n1 should-fix, 1 question · 2 comments on the diff.\nPress Send to post it on GitHub and reply in the Slack thread.",
    asks: ["Which Slack channel to listen in", "Which repositories count", "Which team mention counts as you", ...CONFIRMS],
  },
  {
    id: "weekday-brief",
    title: "Weekday PR brief",
    description: "Every weekday at 09:00, a Slack DM with the PRs waiting for your review, most urgent first.",
    icon: "brief",
    trigger: "schedule",
    when: "Weekdays at 09:00",
    output: "A Slack DM to you",
    request:
      "Create a Lotus automation that every weekday at 09:00 sends me a Slack DM summarising the PRs waiting for my review, most urgent first.",
    sample: "PRs waiting for your review · 3\n• acme-api#2952 — waiting 2 days, blocks a release\n• orbit-app#42 — small, 40 lines\n• lotus#310 — re-review after changes",
    asks: [...CONFIRMS],
  },
  {
    id: "friday-digest",
    title: "Friday review digest",
    description: "Friday afternoon: what is still open in your review queue, grouped by repository.",
    icon: "digest",
    trigger: "schedule",
    when: "Fridays at 16:00",
    output: "A Slack DM to you",
    request:
      "Create a Lotus automation that every Friday at 16:00 sends me a Slack DM listing the PRs still waiting for my review, grouped by repository, oldest first.",
    sample: "Still open in your queue · 4 PRs\nacme-api · 2 (oldest: 5 days)\norbit-app · 1\nlotus · 1",
    asks: [...CONFIRMS],
  },
  {
    id: "stale-reviews",
    title: "Stale review requests",
    description: "Each morning, the review requests older than two days, so none quietly ages out.",
    icon: "stale",
    trigger: "schedule",
    when: "Weekdays at 08:30",
    output: "A Slack DM to you, only when something is stale",
    request:
      "Create a Lotus automation that every weekday at 08:30 sends me a Slack DM with only the PRs that have waited more than two days for my review.",
    sample: "2 review requests waited more than two days:\n• acme-api#2940 — 4 days\n• orbit-app#38 — 3 days",
    asks: [...CONFIRMS],
  },
];

/** The agent is told how, not only what: the skill, the tools, and a yes before it saves. */
export function agentPromptFor(request: string): string {
  return (
    `${request.trim()}\n\n` +
    "Use the lotus-automation skill and the lotus_automation_* tools. Look up ids with lotus_automation_options. " +
    "Show me a short summary (trigger, action, output, GitHub account, preset, project) with the full prompt " +
    "text you will save, and wait for my yes before you create it."
  );
}
