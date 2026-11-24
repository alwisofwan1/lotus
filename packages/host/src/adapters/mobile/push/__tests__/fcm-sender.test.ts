import { describe, expect, it } from "vitest";

import type { FcmCredentials } from "../fcm-credentials.js";
import {
  classify,
  FcmSender,
  notificationTag,
  type PushMessage,
  type SendFetcher,
} from "../fcm-sender.js";

const RANG: PushMessage = { kind: "attention", title: "Atlas", body: "needs you", paneId: "p-1" };

/** Just enough of the credentials to send: a project id and a bearer. */
function credentials(): FcmCredentials {
  return {
    account: { projectId: "lotus-pocket", clientEmail: "", privateKey: "", tokenUri: "" },
    accessToken: async () => "ya29.token",
  } as unknown as FcmCredentials;
}

describe("FcmSender", () => {
  function capture(reply = { status: 200, text: "{}" }) {
    const calls: Array<{ uri: string; headers: Record<string, string>; body: string }> = [];
    const fetchSend: SendFetcher = async (uri, init) => {
      calls.push({ uri, headers: init.headers, body: init.body });
      return reply;
    };
    return { calls, sender: new FcmSender(credentials(), fetchSend) };
  }

  it("posts to the project's v1 send endpoint with the access token", async () => {
    const { calls, sender } = capture();

    await sender.send("tok-device", RANG);

    expect(calls[0]!.uri).toBe(
      "https://fcm.googleapis.com/v1/projects/lotus-pocket/messages:send",
    );
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer ya29.token");
  });

  /**
   * The line `issues/04` drew on 2026-08-27, and the test that keeps it drawn.
   *
   * Until then the message was a fixed sentence naming nobody. The policy now lets
   * through the agent's **display name** and one short fixed phrase, so the operator
   * knows who rang without opening the app. What still never travels is anything from
   * the event itself: `tool_target: "rm src/legacy/shim.ts"`, `cwd`, the prompt. That
   * holds structurally — `PushMessage` has no field for them — and this asserts the
   * whole payload rather than "contains", so an added field has to be argued for here.
   */
  it("carries the agent's name and one sentence — never a path, a command or a prompt", async () => {
    const { calls, sender } = capture();

    await sender.send("tok-device", RANG);

    const message = JSON.parse(calls[0]!.body).message;
    expect(message.notification).toEqual({ title: "Atlas", body: "needs you" });
    expect(message.data).toEqual({ kind: "attention", paneId: "p-1" });
    expect(Object.keys(message)).toEqual(["token", "notification", "data", "android"]);
  });

  /**
   * One tray entry per agent, newest wins (`issues/04`, aggregation rule). Android
   * replaces a notification whose `tag` matches, so `needs you` followed by `finished`
   * from the same pane is one line saying the latest thing — while two agents keep
   * two lines.
   */
  it("tags the notification by pane so a newer wake-up from the same agent replaces the older", async () => {
    const { calls, sender } = capture();

    await sender.send("tok-device", RANG);
    await sender.send("tok-device", { ...RANG, kind: "finished", body: "finished" });

    const tags = calls.map((c) => JSON.parse(c.body).message.android.notification.tag);
    expect(tags[0]).toBe(tags[1]);
    expect(tags[0]).toBe(notificationTag("p-1"));
    expect(notificationTag("p-2")).not.toBe(notificationTag("p-1"));
  });

  it("is high priority, collapsed under one key, and short-lived", async () => {
    const { calls, sender } = capture();

    await sender.send("tok-device", RANG);

    const { android } = JSON.parse(calls[0]!.body).message;
    expect(android.priority).toBe("high");
    // One constant, not per pane: FCM allows four distinct collapse keys in flight per
    // device, and a fifth agent's wake-up would be dropped silently.
    expect(android.collapse_key).toBe("lotus-attention");
    expect(android.ttl).toBe("600s");
    expect(android.channel_id).toBeUndefined();
  });

  it("reports what the caller should do next", async () => {
    const { sender } = capture({ status: 200, text: "{}" });

    expect(await sender.send("tok-device", RANG)).toBe("sent");
  });
});

describe("classify", () => {
  it("treats any 2xx as delivered to FCM", () => {
    expect(classify(200, "{}")).toBe("sent");
  });

  /**
   * The distinction that matters most: a dead token must be dropped, or the host keeps
   * signing JWTs and posting to a phone that no longer exists, forever.
   */
  it("recognises a dead registration token by name as well as by 404", () => {
    expect(classify(404, "{}")).toBe("unregistered");
    expect(classify(400, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}')).toBe(
      "unregistered",
    );
    expect(classify(400, '{"error":"registration-token-not-registered"}')).toBe("unregistered");
  });

  it("separates try-again-later from a refusal retrying cannot fix", () => {
    expect(classify(429, "")).toBe("unavailable");
    expect(classify(503, "")).toBe("unavailable");
    // Wrong project, or a revoked key: retrying would send the same request forever.
    expect(classify(403, '{"error":"SENDER_ID_MISMATCH"}')).toBe("rejected");
    expect(classify(401, "")).toBe("rejected");
  });
});
