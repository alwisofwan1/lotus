import type { FcmCredentials } from "./fcm-credentials.js";

/** What a delivery attempt tells the caller to do next. */
export type SendOutcome =
  /** Accepted for delivery. */
  | "sent"
  /** This registration token is dead — the app was uninstalled, or FCM rotated it. */
  | "unregistered"
  /** Refused for a reason retrying will not fix (wrong project, revoked key). */
  | "rejected"
  /** Temporary: throttling, or FCM having a bad minute. */
  | "unavailable";

/** Why a phone is being woken — the two states `issues/04` settled on. */
export type WakeKind = "attention" | "finished";

/**
 * The whole of what leaves the host. Closed on purpose: events carry tool targets, `cwd` and
 * prompts that must not leak; only the **display name** and one fixed sentence are allowed
 * (`issues/04`). The pane id in `data` is an opaque uuid.
 */
export interface PushMessage {
  kind: WakeKind;
  /** The agent's display name, as the canvas shows it (`Atlas`, `acme`). */
  title: string;
  /** One short sentence in the app's own vocabulary: `needs you`, `finished`. */
  body: string;
  paneId: string;
}

export interface PushSender {
  send(registrationToken: string, message: PushMessage): Promise<SendOutcome>;
}

/** The HTTP shape this module needs, injected so tests never reach the network. */
export type SendFetcher = (
  uri: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: string }>;

/**
 * The `notification` block is needed: a data-only message shows nothing for a closed app.
 * Newer replaces older per agent via the Android `tag` (`issues/04`). `collapse_key` stays one
 * constant: FCM allows four distinct keys in flight, so a per-pane key drops the fifth agent.
 */
export class FcmSender implements PushSender {
  constructor(
    private readonly credentials: FcmCredentials,
    private readonly fetchSend: SendFetcher,
  ) {}

  async send(registrationToken: string, message: PushMessage): Promise<SendOutcome> {
    const accessToken = await this.credentials.accessToken();
    const uri = `https://fcm.googleapis.com/v1/projects/${this.credentials.account.projectId}/messages:send`;

    const reply = await this.fetchSend(uri, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: registrationToken,
          notification: { title: message.title, body: message.body },
          data: { kind: message.kind, paneId: message.paneId },
          android: {
            priority: "high",
            collapse_key: "lotus-attention",
            ttl: "600s",
            notification: { tag: notificationTag(message.paneId) },
          },
        },
      }),
    });

    return classify(reply.status, reply.text);
  }
}

/** The tray slot an agent's wake-ups share; bounded so a long pane id stays a valid tag. */
export function notificationTag(paneId: string): string {
  return `lotus-pane-${paneId.slice(-32)}`;
}

/**
 * Maps FCM's answer onto what the caller can do; `unregistered` must stay distinct: a dead
 * token has to be **dropped** or the host posts to it forever.
 */
export function classify(status: number, body: string): SendOutcome {
  if (status >= 200 && status < 300) return "sent";

  if (status === 404 || body.includes("UNREGISTERED") || body.includes("registration-token-not-registered")) {
    return "unregistered";
  }
  if (status === 429 || status >= 500) return "unavailable";
  return "rejected";
}
