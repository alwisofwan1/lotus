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
 * Everything a wake-up may say, and the whole of what leaves the host.
 *
 * Deliberately a closed shape rather than the event itself: the notification events
 * behind a wake-up carry `tool_target: "rm src/legacy/shim.ts"`, `cwd` and the
 * operator's own prompt, and none of those have a field here to travel in. What
 * `issues/04` allowed through (2026-08-27) is the agent's **display name** and one
 * short fixed sentence — enough to know *who* rang without opening the app, and no
 * more. The pane id rides in `data` so a tap can open the right agent; it is an opaque
 * uuid this host minted, not a path.
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
 * One wake-up, delivered through FCM.
 *
 * The `notification` block is what makes it arrive when the app is not running:
 * Android draws it without waking Flutter at all (decided 2026-08-06 — a data-only
 * message shows nothing when the app has been closed for hours, the state this product
 * exists to cover). `data` rides along for the app that is already open, which draws
 * its own banner instead.
 *
 * **One notification per agent, newer replaces older** (`issues/04`): the Android
 * `tag` is derived from the pane id, so a `needs you` followed by a `finished` from the
 * same agent is one entry in the tray, saying the latest thing. `collapse_key` stays a
 * single constant on purpose — FCM allows only four distinct keys in flight per device,
 * so keying it per pane would silently drop the fifth agent's wake-up.
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
 * Maps FCM's answer onto the four things the caller can actually do.
 *
 * The distinction that matters is `unregistered` versus everything else: a dead token
 * must be **dropped**, or the host keeps signing JWTs and posting to a phone that no
 * longer exists, forever.
 */
export function classify(status: number, body: string): SendOutcome {
  if (status >= 200 && status < 300) return "sent";

  if (status === 404 || body.includes("UNREGISTERED") || body.includes("registration-token-not-registered")) {
    return "unregistered";
  }
  if (status === 429 || status >= 500) return "unavailable";
  return "rejected";
}
