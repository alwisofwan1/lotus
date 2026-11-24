interface ResultLine {
  type: "result";
  subtype: string;
  session_id: string;
  // Error subtypes (error_max_turns, error_during_execution, billing/overage
  // rejections) omit `result` entirely — keep it optional and reconstruct text
  // from the diagnostic fields below so the operator sees the real cause.
  result?: string;
  is_error: boolean;
  errors?: string[];
  api_error_status?: string | null;
}

interface InitLine {
  type: "system";
  subtype: "init";
  session_id: string;
}

type StreamLine = ResultLine | InitLine | { type: string };

export interface ParsedResult {
  sessionId: string;
  text: string;
  isError: boolean;
}

/** Best-effort cause for an error result line that carries no `result` text. */
function describeResultError(r: ResultLine): string {
  const detail = r.errors?.length ? r.errors.join("; ") : r.api_error_status || r.subtype || "unknown error";
  return `claude ended without a reply (${detail})`;
}

/** Parses `claude --output-format stream-json` stdout into a final result. */
export function parseStreamJson(output: string): ParsedResult {
  let sessionId = "";
  let resultText = "";
  let isError = false;
  let hasResult = false;

  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: StreamLine;
    try {
      parsed = JSON.parse(line) as StreamLine;
    } catch {
      continue;
    }
    if ("session_id" in parsed && parsed.session_id && !sessionId) {
      sessionId = parsed.session_id;
    }
    if (parsed.type === "result") {
      const r = parsed as ResultLine;
      sessionId = r.session_id || sessionId;
      isError = r.is_error;
      hasResult = true;
      // `text` is ALWAYS a string (never throws downstream on `.trim()`). When
      // an error subtype omits `result`, reconstruct a cause from the diagnostic
      // fields so the operator gets an actionable message instead of a silent
      // empty reply (the "(empty response)" bug).
      if (typeof r.result === "string") {
        resultText = r.result;
      } else if (r.is_error) {
        resultText = describeResultError(r);
      } else {
        resultText = "";
      }
    }
  }

  if (!hasResult) {
    // Process exited without a result line — treat the raw output as error text.
    return { sessionId, text: output.trim(), isError: true };
  }

  return { sessionId, text: resultText, isError };
}
