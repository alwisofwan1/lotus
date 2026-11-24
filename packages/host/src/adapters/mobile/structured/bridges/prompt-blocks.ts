import { readFileSync } from "node:fs";

import type { PromptAttachment } from "../../../../types/provider-bridge.js";

// Same wording as the desktop bridge (`apps/desktop/scripts/chat-bridge`), so a chat reads alike on any machine.
type Read = (path: string) => Buffer;

const isPicture = (a: PromptAttachment) => a.kind === "image" && a.mimeType !== undefined;
const fileLine = (a: PromptAttachment) => `[Attached file ${a.name}. It is on disk at ${a.path} — read it there.]`;

/** Claude `stream-json` user content: images as pictures, other files as a line, the text last. */
export function claudeContent(text: string, attachments: readonly PromptAttachment[], read: Read = readFileSync): Array<Record<string, unknown>> {
  if (attachments.length === 0) return [{ type: "text", text }];
  const blocks: Array<Record<string, unknown>> = attachments.map((a) => {
    if (isPicture(a)) return { type: "image", source: { type: "base64", media_type: a.mimeType, data: read(a.path).toString("base64") } };
    const details = [a.mimeType, a.sizeBytes === undefined ? undefined : `${a.sizeBytes} bytes`].filter(Boolean);
    return { type: "text", text: `[Attached file ${a.name}${details.length ? ` (${details.join(", ")})` : ""}. It is on disk at ${a.path} — use the Read tool to view it.]` };
  });
  if (text.trim()) blocks.push({ type: "text", text });
  return blocks;
}

/** `codex app-server` `turn/start` input: Codex reads `localImage` from disk itself. */
export function codexInput(text: string, attachments: readonly PromptAttachment[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = text.trim() ? [{ type: "text", text, text_elements: [] }] : [];
  for (const a of attachments) {
    input.push(isPicture(a) ? { type: "localImage", path: a.path } : { type: "text", text: fileLine(a), text_elements: [] });
  }
  return input;
}

/** ACP `session/prompt` content blocks. */
export function acpPrompt(text: string, attachments: readonly PromptAttachment[], read: Read = readFileSync): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = attachments.map((a) =>
    isPicture(a) ? { type: "image", mimeType: a.mimeType, data: read(a.path).toString("base64") } : { type: "text", text: fileLine(a) },
  );
  return text.trim() ? [{ type: "text", text }, ...blocks] : blocks;
}
