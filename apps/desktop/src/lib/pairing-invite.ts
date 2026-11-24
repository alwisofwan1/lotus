/**
 * The payload a pairing QR carries, built here and read by
 * `apps/pocket/lib/models/pairing_invite.dart`.
 *
 * Two hand-written implementations of one format is exactly the shape that drifts, so
 * neither side is the authority: `contract/fixtures/pairing-invite.json` holds one
 * golden string and both sides assert against it. Change the format here without
 * regenerating the fixture and the Dart suite goes red, which is the point.
 *
 * **A URI rather than the bare JSON ADR-5 sketched.** The reason is forward-looking and
 * concrete: a custom scheme means a later "scan it with the phone's own camera app"
 * becomes an Android intent filter rather than a redesign of the payload. Nothing
 * registers that scheme today, so the QR is read by the in-app scanner — but the shape
 * does not have to change when it is.
 */

/** Namespaced so a scanner refuses every other barcode in the world. */
export const PAIRING_INVITE_SCHEME = "lotus-pair";

/**
 * Bumped only for a change older phones must NOT half-read.
 *
 * Adding a field is not such a change — the Dart reader ignores unknown parameters on
 * purpose, because a version bump locks out a phone that was working an hour ago.
 */
export const PAIRING_INVITE_VERSION = 1;

export interface PairingInviteInput {
  /** The bound address, as `host_runtime::interfaces` reports it — always a literal IP. */
  host: string;
  port: number;
  /** The eight digits, exactly as the operator would otherwise type them. */
  code: string;
}

/**
 * Builds the scannable payload.
 *
 * No host label rides along, deliberately: ADR-5's sketch had one so the phone could
 * name the machine before redeeming, and there is no such moment — a scan redeems at
 * once and the reply carries the real label. A label here would be a second source of
 * truth for a name, displayed for less time than it takes to read.
 */
export function buildPairingInvite({ host, port, code }: PairingInviteInput): string {
  const address = `${bracketIfIpv6(host)}:${port}`;
  // Built by hand rather than with URLSearchParams: the fixture pins an exact string,
  // and form encoding has its own opinions (`+` for space, ordering by insertion) that
  // would make the golden depend on a runtime detail instead of on this decision.
  const query = [
    `v=${PAIRING_INVITE_VERSION}`,
    `address=${encodeURIComponent(address)}`,
    `code=${encodeURIComponent(code)}`,
  ].join("&");
  return `${PAIRING_INVITE_SCHEME}://invite?${query}`;
}

/**
 * `fd7a:1::2` → `[fd7a:1::2]`, so the colon that separates host from port stays the
 * only one that means that.
 *
 * Without this an IPv6 tailnet address would arrive on the phone as `fd7a:1::2:8787`,
 * which `readAddress` reads as a host of `fd7a` — a pairing that fails with a
 * diagnosis pointing at the network rather than at this line.
 */
function bracketIfIpv6(host: string): string {
  if (!host.includes(":")) return host;
  return host.startsWith("[") ? host : `[${host}]`;
}
