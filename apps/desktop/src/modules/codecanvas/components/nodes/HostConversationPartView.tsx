"use client";
import { memo } from "react";
import { fallbackPartText, rawPartTypeOf, type HostConversationPart } from "../../services/host-conversation";

/**
 * One part of a headless cell's turn.
 *
 * **The contract this component is built around: nothing is dropped.** The part kinds below are
 * the ones read off a real cell plus the ones `packages/host/src/types/conversation.ts` already
 * names — and that list is explicitly not closed. Runners gain kinds, the host gains adapters, and
 * a desktop that quietly skipped what it did not recognise would draw a conversation that is
 * missing steps, with nothing on screen to say so. So there is a fallback, it prints the kind's
 * real name, and it is the default rather than the exception.
 *
 * Every part carries `data-part-type` for the same reason a test can assert on it: "did this reach
 * the screen" is the only question about this component worth failing a build over.
 */
export const HostConversationPartView = memo(function HostConversationPartView({
  part,
}: {
  part: HostConversationPart;
}) {
  const raw = part.raw;
  const text = typeof raw.text === "string" ? raw.text : "";

  switch (part.type) {
    case "user_message":
      return (
        <div className="canvas-hostcell-part canvas-hostcell-part--user" data-part-type={part.type}>
          <span className="canvas-hostcell-part-who">You</span>
          <p className="canvas-hostcell-text">{text}</p>
        </div>
      );

    case "assistant_text":
      return (
        <div
          className="canvas-hostcell-part canvas-hostcell-part--assistant"
          data-part-type={part.type}
          data-streaming={raw.state === "streaming" ? "true" : undefined}
        >
          <p className="canvas-hostcell-text">{text}</p>
          {raw.truncated === true ? (
            // The host caps a hook-sourced reply at 8000 bytes. Saying so is the difference
            // between a short answer and an answer we cut off.
            <span className="canvas-hostcell-note">cut off by the host&rsquo;s size cap</span>
          ) : null}
        </div>
      );

    case "reasoning":
      return (
        <div className="canvas-hostcell-part canvas-hostcell-part--reasoning" data-part-type={part.type}>
          <span className="canvas-hostcell-part-who">thinking</span>
          <p className="canvas-hostcell-text">{raw.redacted === true ? "(redacted by the runner)" : text}</p>
        </div>
      );

    case "tool_call": {
      const files = Array.isArray((raw.diff as { files?: unknown })?.files)
        ? ((raw.diff as { files: Array<Record<string, unknown>> }).files)
        : [];
      const output = raw.output as { text?: string; exitCode?: number } | undefined;
      return (
        <div
          className="canvas-hostcell-part canvas-hostcell-part--tool"
          data-part-type={part.type}
          data-tool-status={typeof raw.status === "string" ? raw.status : undefined}
        >
          <div className="canvas-hostcell-tool-head">
            <span className="canvas-hostcell-tool-name">{typeof raw.toolName === "string" ? raw.toolName : "tool"}</span>
            <span className="canvas-hostcell-tool-title">{typeof raw.title === "string" ? raw.title : ""}</span>
            <span className="canvas-hostcell-tool-status">{typeof raw.status === "string" ? raw.status : "?"}</span>
          </div>
          {files.length > 0 ? (
            <ul className="canvas-hostcell-diff">
              {files.map((file, index) => (
                <li key={`${String(file.path)}-${index}`}>
                  <span className="canvas-hostcell-diff-path">{String(file.path ?? "")}</span>
                  {/* Absent, not zero, when the pipeline had no count — printing "+0 -0" for a
                      diff nobody counted would be a measurement we never made. */}
                  {typeof file.additions === "number" ? <span className="canvas-hostcell-diff-add">+{file.additions}</span> : null}
                  {typeof file.deletions === "number" ? <span className="canvas-hostcell-diff-del">-{file.deletions}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {output?.text ? <pre className="canvas-hostcell-output">{output.text}</pre> : null}
        </div>
      );
    }

    case "plan_update": {
      const entries = Array.isArray(raw.entries) ? (raw.entries as Array<Record<string, unknown>>) : [];
      return (
        <div className="canvas-hostcell-part canvas-hostcell-part--plan" data-part-type={part.type}>
          <span className="canvas-hostcell-part-who">plan</span>
          <ul className="canvas-hostcell-plan">
            {entries.map((entry, index) => (
              <li key={index} data-plan-status={typeof entry.status === "string" ? entry.status : undefined}>
                {String(entry.content ?? "")}
              </li>
            ))}
          </ul>
        </div>
      );
    }

    case "permission":
    case "question":
      // The canvas cannot answer one: `/v1` carries dispatch and nothing else, and the route that
      // answers a permission wants the pairing credential a phone holds. Saying where it can be
      // answered is more use than a button that would fail.
      return (
        <div className="canvas-hostcell-part canvas-hostcell-part--attention" data-part-type={part.type}>
          <span className="canvas-hostcell-part-who">needs an answer</span>
          <p className="canvas-hostcell-text">{fallbackPartText(part)}</p>
          <span className="canvas-hostcell-note">answer it from Lotus Pocket — this node can only send prompts</span>
        </div>
      );

    case "status":
      return (
        <div className="canvas-hostcell-part canvas-hostcell-part--status" data-part-type={part.type}>
          <span className="canvas-hostcell-chip">{String(raw.state ?? "status")}</span>
          {typeof raw.detail === "string" && raw.detail ? <span className="canvas-hostcell-note">{raw.detail}</span> : null}
        </div>
      );

    case "mode_change":
      return (
        <div className="canvas-hostcell-part canvas-hostcell-part--status" data-part-type={part.type}>
          <span className="canvas-hostcell-chip">mode</span>
          <span className="canvas-hostcell-note">{String(raw.modeId ?? "")}</span>
        </div>
      );

    case "error":
      return (
        <div className="canvas-hostcell-part canvas-hostcell-part--error" data-part-type={part.type}>
          <span className="canvas-hostcell-part-who">error</span>
          <p className="canvas-hostcell-text">{String(raw.message ?? fallbackPartText(part))}</p>
        </div>
      );

    case "result": {
      const usage = raw.usage as Record<string, number> | undefined;
      return (
        <div
          className="canvas-hostcell-part canvas-hostcell-part--result"
          data-part-type={part.type}
          data-is-error={raw.isError === true ? "true" : undefined}
        >
          {raw.isError === true ? <span className="canvas-hostcell-chip">failed</span> : null}
          {typeof raw.durationMs === "number" ? <span className="canvas-hostcell-note">{Math.round(raw.durationMs / 100) / 10}s</span> : null}
          {typeof raw.costUsd === "number" ? <span className="canvas-hostcell-note">${raw.costUsd.toFixed(4)}</span> : null}
          {usage && typeof usage.input === "number" ? <span className="canvas-hostcell-note">{usage.input} in</span> : null}
          {usage && typeof usage.output === "number" ? <span className="canvas-hostcell-note">{usage.output} out</span> : null}
        </div>
      );
    }

    default:
      // Everything the canvas has no component for, including the host's own `unknown` part —
      // whose real kind is in `rawType`, and printing the word "unknown" over it would hide the
      // one fact worth reporting.
      return (
        <div className="canvas-hostcell-part canvas-hostcell-part--raw" data-part-type={part.type} data-fallback="true">
          <span className="canvas-hostcell-chip">{rawPartTypeOf(part)}</span>
          <p className="canvas-hostcell-text">{fallbackPartText(part)}</p>
        </div>
      );
  }
});
