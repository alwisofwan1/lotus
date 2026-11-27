import { RateLimiter } from "../../../core/rate-limiter.js";
import type { Fields } from "../../../core/logger.js";
import type { FleetMember } from "../../../types/fleet.js";
import type { NotificationEvent } from "../../../types/notifications.js";
import type { DeviceStore } from "../device-store.js";
import type { PushSender } from "./fcm-sender.js";
import { AskLedger, composeMessage, wakeKindFor } from "./push-policy.js";

/**
 * At most one wake-up every 30s per device, six in a burst.
 *
 * Sits beneath `push-policy.ts` so a runaway agent cannot drain a battery.
 */
const BURST = 6;
const REFILL_PER_SEC = 1 / 30;

export interface PushServiceDeps {
  devices: DeviceStore;
  sender: PushSender;
  log: (message: string, fields?: Fields) => void;
  /** Names the agent in the message; absent (tests) falls back to "An agent". */
  fleetSnapshot?: () => Promise<FleetMember[]>;
  /**
   * Device ids currently looking at this pane over a live socket. Those phones are
   * already watching the thing ring; a banner on top would say what the screen says.
   */
  viewing?: (paneId: string) => ReadonlySet<string>;
  now?: () => number;
}

/**
 * Notification events → wake-ups. Same source as the WebSocket: socket covers foreground,
 * this covers background (ADR-4). Qualifying events live in `push-policy.ts`.
 */
export class PushService {
  private readonly limiter: RateLimiter;
  private readonly asked = new AskLedger();

  constructor(private readonly deps: PushServiceDeps) {
    this.limiter = new RateLimiter({
      capacity: BURST,
      refillPerSec: REFILL_PER_SEC,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  }

  /** A phone sent this pane an ask; its finish is now worth a wake-up. */
  recordAsk(paneId: string): void {
    this.asked.record(paneId);
  }

  /**
   * The fleet, for the agent's name — or nothing, never a throw: a rejection inside the
   * relay's `for await` ends the event stream until reconnect.
   */
  private async names(): Promise<FleetMember[]> {
    try {
      return (await this.deps.fleetSnapshot?.()) ?? [];
    } catch (error) {
      this.deps.log("mobile.push.fleet_unavailable", { error: String(error) });
      return [];
    }
  }

  /**
   * Sends a wake-up if this event deserves one.
   *
   * Failures are logged and swallowed: an FCM outage must not break the socket loop that calls this.
   */
  async notify(event: NotificationEvent): Promise<void> {
    const kind = wakeKindFor(event, this.asked);
    if (kind === null || event.kind !== "agent_stop") return;

    const paneId = event.pane_id ?? "";
    const message = composeMessage(kind, paneId, await this.names(), event.status);
    const watching = this.deps.viewing?.(paneId) ?? new Set<string>();

    for (const device of this.deps.devices.withPushToken()) {
      if (watching.has(device.deviceId)) {
        this.deps.log("mobile.push.viewing", { deviceId: device.deviceId, paneId });
        continue;
      }
      if (!this.limiter.allow(device.deviceId)) {
        this.deps.log("mobile.push.throttled", { deviceId: device.deviceId });
        continue;
      }

      try {
        const outcome = await this.deps.sender.send(device.pushToken, message);
        if (outcome === "unregistered") {
          this.deps.devices.clearPushToken(device.deviceId);
          this.deps.log("mobile.push.unregistered", { deviceId: device.deviceId });
          continue;
        }
        this.deps.log(`mobile.push.${outcome}`, { deviceId: device.deviceId, kind });
      } catch (error) {
        this.deps.log("mobile.push.failed", {
          deviceId: device.deviceId,
          error: String(error),
        });
      }
    }
  }
}

/**
 * The service, or `null` for a host with no push credentials.
 *
 * "Can this host wake a phone" is a fact about the service, so the decision lives here.
 */
export function pushServiceOrNull(
  deps: Omit<PushServiceDeps, "sender"> & { sender?: PushServiceDeps["sender"] },
): PushService | null {
  const { sender } = deps;
  return sender === undefined ? null : new PushService({ ...deps, sender });
}

