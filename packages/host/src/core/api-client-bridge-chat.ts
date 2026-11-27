import type { BridgeChatRequest, BridgeChatResponse } from "../types/index.js";
import { parseErrorMessage } from "./api-client-util.js";
import { ApiError } from "./api-error.js";

/** Heartbeats keep long replies alive; read the complete stream before parsing JSON. */
export async function postBridgeChat(
  baseUrl: string,
  headers: Record<string, string>,
  req: BridgeChatRequest,
): Promise<BridgeChatResponse> {
  // Remote-adapter origin → Remote Session Scope by default; explicit flag wins (ADR-0018).
  const resp = await fetch(`${baseUrl}/api/bridge/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ remoteScoped: true, ...req }),
  });
  const raw = await resp.text();
  if (!resp.ok) {
    throw new ApiError(resp.status, parseErrorMessage(raw) ?? resp.statusText);
  }

  let frame: { error?: string; errorStatus?: number };
  try {
    frame = JSON.parse(raw) as { error?: string; errorStatus?: number };
  } catch {
    throw new ApiError(502, "malformed bridge reply");
  }
  if (typeof frame.error === "string") {
    throw new ApiError(frame.errorStatus ?? 500, frame.error);
  }
  return frame as unknown as BridgeChatResponse;
}
