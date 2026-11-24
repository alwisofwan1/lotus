import type { ClaudeConversation } from "./conversation.js";
import { isRecord } from "../acp/parts.js";
import {
  blocksOf,
  toolKindOf,
  toolResultText,
  toolTargetOf,
  type ClaudeMessage,
} from "./messages.js";
import type { ToolCallPart } from "../../../../../types/conversation.js";

/**
 * Reading Claude's content blocks: the `stream_event` deltas, the whole `assistant` message,
 * and the `tool_result` that comes back as a `user` message.
 *
 * Split out of `conversation.ts` when that file crossed 300 lines, and the seam is the right
 * one rather than a convenient one: everything here is *interpretation of a message*, where
 * what stays behind is *the timeline* — turns, part identity, ordering, emission. The
 * conversation is passed in as the sink it already was.
 */
/**
 * A partial chunk. The whole `assistant` message follows, so a delta is a view, not the record.
 *
 * The first chunk **opens** the part, and every chunk after it is sent as the characters it
 * added and nothing else (`ConversationUpdate.kind: "text"`). Re-sending the growing part each
 * time was quadratic in the length of the reply, on the one lane that crosses a tailnet to a
 * phone.
 */
export function applyDelta(c: ClaudeConversation, message: ClaudeMessage): void {
  const event = message["event"];
  if (!isRecord(event) || event["type"] !== "content_block_delta") return;
  const delta = event["delta"];
  if (!isRecord(delta) || typeof delta["text"] !== "string" || delta["text"] === "") return;
  const turnId = c.turnId();
  const id = c.streamingText ?? `text-${turnId}-${c.seqNow()}`;
  if (c.appendText(id, delta["text"])) return;
  c.streamingText = id;
  c.upsert({
    type: "assistant_text",
    text: delta["text"],
    state: "streaming",
    truncated: false,
    ...c.stamp(id),
  });
}

export function applyAssistant(c: ClaudeConversation, message: ClaudeMessage): void {
  for (const block of blocksOf(message)) {
    switch (block.type) {
      case "text": {
        const text = typeof block["text"] === "string" ? block["text"] : "";
        if (text === "") break;
        // The whole message settles whatever was streaming, rather than adding a second
        // copy of the same words beside it.
        const id = c.streamingText ?? `text-${c.turnId()}-${c.seqNow()}`;
        c.streamingText = undefined;
        c.upsert({
          type: "assistant_text",
          text,
          state: "done",
          truncated: false,
          ...c.stamp(id),
        });
        break;
      }
      case "thinking": {
        const text = typeof block["thinking"] === "string" ? block["thinking"] : "";
        if (text === "") break;
        c.upsert({
          type: "reasoning",
          text,
          redacted: false,
          ...c.stamp(`think-${c.turnId()}-${c.seqNow()}`),
        });
        break;
      }
      case "tool_use": {
        const toolCallId = typeof block["id"] === "string" ? block["id"] : "";
        if (toolCallId === "") break;
        const name = typeof block["name"] === "string" ? block["name"] : "tool";
        c.upsert({
          type: "tool_call",
          toolCallId,
          toolName: name,
          title: toolTargetOf(name, block["input"]),
          kind: toolKindOf(name),
          status: "in_progress",
          locations: [],
          ...c.stamp(`tool-${toolCallId}`),
        });
        break;
      }
      default:
        break;
    }
  }
}

/** A `user` message on this stream is a tool result coming back, never the operator. */
export function applyToolResults(c: ClaudeConversation, message: ClaudeMessage): void {
  for (const block of blocksOf(message)) {
    if (block.type !== "tool_result") continue;
    const toolCallId = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "";
    const held = c.existing(`tool-${toolCallId}`);
    if (held?.type !== "tool_call") continue;
    const text = toolResultText(block["content"]);
    const isError = block["is_error"] === true;
    const call: ToolCallPart = {
      ...held,
      status: isError ? "failed" : "completed",
      ...(text === "" ? {} : { output: { text, truncated: false } }),
      seq: c.nextSeq(),
    };
    c.upsert(call);
  }
}
