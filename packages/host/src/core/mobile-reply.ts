export interface MobileReply {
  title?: string;
  sections: MobileReplySection[];
  nextActions?: string[];
  rawDetail?: string;
}

export interface MobileReplySection {
  title: string;
  bullets?: string[];
  body?: string;
}

export function normalizeAgentReply(input: string): MobileReply {
  const bullets = input.split("\n").map(parseSummaryBullet).filter((b) => b !== null);
  const nextActions = bullets
    .filter((b) => /^next(?: step| action)?$/i.test(b.label))
    .map((b) => b.value);
  const changed = bullets
    .filter((b) => !/^next(?: step| action)?$/i.test(b.label))
    .map((b) => `${b.label}: ${b.value}`);

  const reply: MobileReply = {
    sections: changed.length > 0 ? [{ title: "Changed", bullets: changed }] : [],
    rawDetail: input,
  };
  if (detectDone(input)) reply.title = "✅ Done";
  if (nextActions.length > 0) reply.nextActions = nextActions;
  return reply;
}

export function renderMobileReplyMarkdown(reply: MobileReply): string {
  const parts: string[] = [];
  if (reply.title) parts.push(reply.title);

  for (const section of reply.sections) {
    parts.push(renderSection(section));
  }

  if (reply.nextActions && reply.nextActions.length > 0) {
    parts.push(["**Next**", ...reply.nextActions.map((item) => `- ${item}`)].join("\n"));
  }

  return parts.join("\n\n");
}

export function maybeCompactAgentReply(input: string): string {
  const reply = normalizeAgentReply(input);
  if (!reply.title && !reply.nextActions) return input;
  if (reply.sections.length === 0 && !reply.nextActions) return input;
  return renderMobileReplyMarkdown(reply);
}

function renderSection(section: MobileReplySection): string {
  const lines = [`**${section.title}**`];
  if (section.body) lines.push(section.body);
  if (section.bullets) lines.push(...section.bullets.map((item) => `- ${item}`));
  return lines.join("\n");
}

function parseSummaryBullet(line: string): { label: string; value: string } | null {
  const match = line.match(/^\s*[-*]\s+(.+?):\s+(.+)$/);
  if (!match) return null;
  return {
    label: stripInlineMarkdown(match[1]!).trim(),
    value: stripInlineMarkdown(match[2]!).trim(),
  };
}

function stripInlineMarkdown(input: string): string {
  return input
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
}

function detectDone(input: string): boolean {
  return /^\s*(done|completed|success)/i.test(input);
}
