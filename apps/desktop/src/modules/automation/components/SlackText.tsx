"use client";

import { createContext, memo, useContext, type ReactNode } from "react";

import { openExternalLink } from "@/lib/tauri-api";

/**
 * A message exactly as Slack will show it, from the text Lotus posts (Slack's own wire format:
 * mrkdwn, `<@U…>` mentions, `&lt;`-style escapes). The Inbox renders this instead of markdown,
 * because markdown lies about Slack: `*bold*` would show as italic, and a mention that will ping
 * would show as nothing at all. No raw HTML: every piece becomes a React node.
 */
export const SlackText = memo(function SlackText({ children, empty }: { children: string; empty?: string }) {
  if (!children.trim()) return <p className="au-review-text au-review-text--empty">{empty ?? "Empty."}</p>;
  return <div className="au-review-text au-slack-text">{blocks(children)}</div>;
});

/**
 * Slack user id → name, for a `<@U…>` mention to read as the person it pings. The wire text keeps
 * the id, so the message still pings; only the preview reads it.
 */
export const SlackUserNames = createContext<ReadonlyMap<string, string>>(new Map());

function UserMention({ id }: { id: string }) {
  const name = useContext(SlackUserNames).get(id);
  return (
    <span className="au-slack-mention" title={`Pings Slack user ${id}`}>
      @{name ?? id}
    </span>
  );
}

/** A list line as `slack/rich.rs` reads it: indent, marker, item text. */
const LIST_ITEM = /^([ \t]*)[•◦▪-] (?=\S)(.*)$/;

function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [line.trimStart().slice(3)];
      while (++i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i]);
      out.push(
        <pre key={i}>
          <code>{decode(code.filter((l, n) => n > 0 || l).join("\n"))}</code>
        </pre>,
      );
      continue;
    }
    if (line.startsWith("> ")) {
      out.push(<blockquote key={i}>{inline(line.slice(2), i)}</blockquote>);
      continue;
    }
    // Lotus posts `• ` lines as a real Slack list (a `rich_text` block), so a long item wraps
    // under its own text, not back to the margin.
    const item = LIST_ITEM.exec(line);
    if (item) {
      const level = Math.min(Math.ceil(item[1].replace(/\t/g, "  ").length / 2), 4);
      out.push(
        <div key={i} className="au-slack-item" data-level={level}>
          {inline(item[2], i)}
        </div>,
      );
      continue;
    }
    out.push(
      <div key={i} className={line.trim() ? "au-slack-line" : "au-slack-gap"}>
        {inline(line.trimStart(), i)}
      </div>,
    );
  }
  return out;
}

/** Code spans first (nothing inside them is formatted), then tokens, then text styles. */
function inline(line: string, key: number): ReactNode[] {
  return line.split(/(`[^`\n]+`)/).map((part, n) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <code key={`${key}-${n}`}>{decode(part.slice(1, -1))}</code>
    ) : (
      <span key={`${key}-${n}`}>{tokens(part, `${key}-${n}`)}</span>
    ),
  );
}

const TOKEN = /<([^<>]+)>/g;

function tokens(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    out.push(...styled(text.slice(last, at), `${key}-${at}t`));
    out.push(token(match[1], `${key}-${at}k`));
    last = at + match[0].length;
  }
  out.push(...styled(text.slice(last), `${key}-end`));
  return out;
}

function token(inner: string, key: string): ReactNode {
  const [target, label] = inner.split("|");
  const chip = (text: string, title: string) => (
    <span key={key} className="au-slack-mention" title={title}>
      {text}
    </span>
  );
  if (target.startsWith("@")) return label ? chip(`@${label}`, `Pings Slack user ${target.slice(1)}`) : <UserMention key={key} id={target.slice(1)} />;
  if (target.startsWith("!subteam^")) return chip(`@${label ?? target.slice(9)}`, "Pings this user group");
  if (target.startsWith("#")) return chip(`#${label ?? target.slice(1)}`, "Links a channel");
  if (target.startsWith("!")) return chip(`@${target.slice(1)}`, `Pings everyone in @${target.slice(1)}`);
  return <Link key={key} href={target} label={label ?? target} />;
}

// Slack's rules: a marker opens after a space or line start and closes before one.
const STYLE = /(^|[\s(])([*_~])(?=\S)([^\n]*?\S)\2(?=$|[\s.,;:!?)])/g;
const URL = /https?:\/\/[^\s<>]+[^\s<>.,;:!?)]/g;

function styled(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(STYLE)) {
    const at = (match.index ?? 0) + match[1].length;
    out.push(...plain(text.slice(last, at), `${key}-${at}p`));
    const inner = styled(match[3], `${key}-${at}i`);
    const Tag = match[2] === "*" ? "strong" : match[2] === "_" ? "em" : "del";
    out.push(<Tag key={`${key}-${at}s`}>{inner}</Tag>);
    last = at + match[2].length * 2 + match[3].length;
  }
  out.push(...plain(text.slice(last), `${key}-rest`));
  return out;
}

function plain(text: string, key: string): ReactNode[] {
  const decoded = emoji(decode(text));
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of decoded.matchAll(URL)) {
    const at = match.index ?? 0;
    if (at > last) out.push(decoded.slice(last, at));
    out.push(<Link key={`${key}-${at}`} href={match[0]} label={match[0]} />);
    last = at + match[0].length;
  }
  if (last < decoded.length) out.push(decoded.slice(last));
  return out;
}

function Link({ href, label }: { href: string; label: string }) {
  const url = decode(href);
  return (
    <a
      href={url}
      title={url}
      onClick={(event) => {
        event.preventDefault();
        if (/^https?:/i.test(url)) void openExternalLink(url);
      }}
    >
      {decode(label)}
    </a>
  );
}

function decode(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The shortcodes agents and people actually write; any other `:name:` stays as typed. */
const EMOJI: Record<string, string> = {
  pray: "🙏",
  "+1": "👍",
  thumbsup: "👍",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  warning: "⚠️",
  rocket: "🚀",
  tada: "🎉",
  eyes: "👀",
  fire: "🔥",
  bug: "🐛",
  memo: "📝",
  bulb: "💡",
  wrench: "🔧",
  hammer_and_wrench: "🛠️",
  mag: "🔍",
  point_right: "👉",
  pushpin: "📌",
  hourglass: "⌛",
  construction: "🚧",
  sparkles: "✨",
  smile: "😄",
  sweat_smile: "😅",
  raised_hands: "🙌",
  clap: "👏",
  calendar: "📆",
  chart_with_upwards_trend: "📈",
};

function emoji(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/g, (whole, name: string) => EMOJI[name] ?? whole);
}
