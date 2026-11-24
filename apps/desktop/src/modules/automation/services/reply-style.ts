/**
 * The Slack reply's shape, read from a PR review's instructions, for the editor's preview.
 *
 * A mirror of crate `lotus-automation` › `pr_review/reply_style.rs` (parse, check, render) and the
 * default values `slack/reply.rs` fills. Rust stays the source of truth: it checks the
 * instructions on save and renders the reply that is sent. This copy only lets the owner see the
 * result, and the save error, while typing. Keep the two in step.
 */

/** What a one-PR block (`slack-reply`, `slack-reply-lgtm`, their re-review twins, and a group's items) may hold. */
export const REPLY_PLACEHOLDERS = ["mention", "verdict", "pr", "counts", "points", "title", "author", "lead"] as const;
/** What the `slack-reply-group` block may hold: one message for a thread that asked for several PRs. */
export const GROUP_PLACEHOLDERS = ["mention", "count", "reviews"] as const;
const FINDINGS = "{mention} {verdict} on {pr} · {counts}\n{points}";
const LGTM = "{mention} LGTM ✅ {pr}";
const GROUP = "{mention} Review selesai untuk {count} PR:\n\n{reviews}";
const ITEM = "{pr} — {verdict}\n{points}";
const ITEM_LGTM = "{pr} — LGTM ✅\nOptional: {counts}";
const MAX_TEMPLATE_CHARS = 500;
const FENCE = "```";
const BLOCK = "slack-reply";
const LGTM_BLOCK = "slack-reply-lgtm";
const GROUP_BLOCK = "slack-reply-group";
const ITEM_BLOCK = "slack-reply-group-item";
const ITEM_LGTM_BLOCK = "slack-reply-group-item-lgtm";
const REREVIEW_BLOCK = "slack-reply-rereview";
const REREVIEW_LGTM_BLOCK = "slack-reply-rereview-lgtm";
const GROUP_REREVIEW_BLOCK = "slack-reply-group-rereview";
const BLOCKS = [BLOCK, LGTM_BLOCK, GROUP_BLOCK, ITEM_BLOCK, ITEM_LGTM_BLOCK, REREVIEW_BLOCK, REREVIEW_LGTM_BLOCK, GROUP_REREVIEW_BLOCK];

export type ReplyStyle = {
  /** For a review with findings or questions. */
  findings: string | null;
  /** For a looks-good review: approved, sent as a comment, or Slack only. `{counts}` names its suggestions. */
  lgtm: string | null;
  /** For the one message of a thread that asked for several PRs. */
  group: string | null;
  /** One PR's part inside the group message, with findings or questions. */
  groupItem?: string | null;
  /** One PR's part inside the group message, when it looks good. */
  groupItemLgtm?: string | null;
  /** A re-review with findings or questions; else `findings`. */
  rereview?: string | null;
  /** A re-review that looks good; else `lgtm`. */
  rereviewLgtm?: string | null;
  /** The one message for several PRs that were all reviewed before; else `group`. */
  groupRereview?: string | null;
};

export type ReplyValues = Record<(typeof REPLY_PLACEHOLDERS)[number], string>;

/** The reply's shape in `instructions`, or the save error Rust would give for them. */
export function parseReplyStyle(instructions: string): { style: ReplyStyle } | { error: string } {
  const style: ReplyStyle = { findings: null, lgtm: null, group: null, groupItem: null, groupItemLgtm: null, rereview: null, rereviewLgtm: null, groupRereview: null };
  const lines = instructions.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith(FENCE)) continue;
    const info = trimmed.slice(FENCE.length).trim();
    if (!info.startsWith(BLOCK)) continue;
    const slots: Record<string, keyof ReplyStyle> = {
      [BLOCK]: "findings", [LGTM_BLOCK]: "lgtm", [GROUP_BLOCK]: "group", [ITEM_BLOCK]: "groupItem", [ITEM_LGTM_BLOCK]: "groupItemLgtm",
      [REREVIEW_BLOCK]: "rereview", [REREVIEW_LGTM_BLOCK]: "rereviewLgtm", [GROUP_REREVIEW_BLOCK]: "groupRereview",
    };
    const slot = slots[info] ?? null;
    if (!slot) {
      return {
        error: `instructions: \`\`\`${info} is not a reply block; use one of ${BLOCKS.map((b) => FENCE + b).join(", ")}`,
      };
    }
    if (style[slot] != null) return { error: `instructions: write the \`\`\`${info} block once` };
    const body: string[] = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      if (lines[i].trim() === FENCE) {
        closed = true;
        break;
      }
      body.push(lines[i]);
    }
    if (!closed) return { error: `instructions: the \`\`\`${info} block has no closing \`\`\`` };
    const checked = check(info, body.join("\n").trim());
    if ("error" in checked) return checked;
    style[slot] = checked.template;
  }
  return { style };
}

function check(block: string, template: string): { template: string } | { error: string } {
  if (!template) return { error: `instructions: the \`\`\`${block} block is empty` };
  if ([...template].length > MAX_TEMPLATE_CHARS) {
    return { error: `instructions: the \`\`\`${block} block is longer than ${MAX_TEMPLATE_CHARS} characters` };
  }
  const group = block === GROUP_BLOCK || block === GROUP_REREVIEW_BLOCK;
  const known: readonly string[] = group ? GROUP_PLACEHOLDERS : REPLY_PLACEHOLDERS;
  const other: readonly string[] = group ? REPLY_PLACEHOLDERS : GROUP_PLACEHOLDERS;
  // The same walk as Rust's: each `{` to the next `}`, whatever lies between.
  let rest = template;
  for (let start = rest.indexOf("{"); start >= 0; start = rest.indexOf("{")) {
    const after = rest.slice(start + 1);
    const end = after.indexOf("}");
    if (end < 0) break;
    const name = after.slice(0, end);
    if (!known.includes(name)) {
      const list = known.map((p) => `{${p}}`).join(", ");
      const elsewhere = !other.includes(name)
        ? ""
        : group
          ? " here, only in the one-PR blocks (```slack-reply, ```slack-reply-lgtm, …)"
          : " here, only in ```slack-reply-group";
      return { error: `instructions: \`\`\`${block} has {${name}}, which Lotus does not fill${elsewhere}; use ${list}` };
    }
    rest = after.slice(end + 1);
  }
  return { template };
}

/**
 * The reply as Lotus fills it. A line whose placeholders (the mention aside) all came out empty
 * goes, words and all; any other empty placeholder takes its gap with it.
 */
export function renderReply(style: ReplyStyle, lgtm: boolean, values: ReplyValues, again = false): string {
  const first = lgtm ? style.lgtm : style.findings;
  const later = again ? (lgtm ? style.rereviewLgtm : style.rereview) : null;
  return fill(later ?? first ?? (lgtm ? LGTM : FINDINGS), values);
}

/** One PR's part of a group message; the group says the mention. */
export function renderItem(style: ReplyStyle, lgtm: boolean, values: ReplyValues): string {
  return fill(lgtm ? (style.groupItemLgtm ?? ITEM_LGTM) : (style.groupItem ?? ITEM), { ...values, mention: "" });
}

function fill(template: string, values: ReplyValues): string {
  const out: string[] = [];
  for (const line of template.split("\n")) {
    const used = REPLY_PLACEHOLDERS.filter((key) => key !== "mention" && line.includes(`{${key}}`));
    if (used.length && used.every((key) => !values[key].trim())) continue;
    const filled = REPLY_PLACEHOLDERS.reduce((text, key) => text.split(`{${key}}`).join(values[key]), line);
    for (const l of filled.split("\n")) {
      const tidy = l.split(/\s+/).filter(Boolean).join(" ");
      if (tidy) out.push(tidy);
    }
  }
  return out.join("\n");
}

/**
 * The one message for several PRs: `reviews` rendered without a mention. Blank lines the owner wrote
 * stay. `again`: every PR of it was reviewed before.
 */
export function renderGroup(style: ReplyStyle, mention: string, reviews: string[], again = false): string {
  const out: string[] = [];
  for (const line of ((again ? style.groupRereview : null) ?? style.group ?? GROUP).split("\n")) {
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const filled = line
      .split("{mention}").join(mention)
      .split("{count}").join(String(reviews.length))
      .split("{reviews}").join("\u0000")
      .split(/\s+/).filter(Boolean).join(" ");
    if (filled) out.push(filled.split("\u0000").join(reviews.join("\n\n")));
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** Example values for the preview, shaped as `slack/reply.rs` fills them (Slack markup shown as read). */
export const SAMPLE_REPLY_VALUES: ReplyValues = {
  mention: "@Aditya",
  verdict: "🔧 Changes needed",
  pr: "acme-api#2952",
  counts: "1 should-fix, 1 question",
  points: "• The phone number check runs before the snapshot email is parsed.\n• Should an empty match fall back to the CRM card's number?",
  title: "Match the caller by phone number",
  author: "aditya",
  lead: "",
};

/** A second PR of the same request, for the group preview. */
export const SAMPLE_REPLY_VALUES_2: ReplyValues = {
  mention: "",
  verdict: "✅ Looks good",
  pr: "acme-web#2511",
  counts: "",
  points: "",
  title: "Show the caller's card",
  author: "rina",
  lead: "",
};

/** The agent's opening line on a later round, for the re-review preview. */
export const SAMPLE_LEAD = "Thanks for adding the uninstall test, that covers the leak.";
