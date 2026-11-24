import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildPairingInvite, PAIRING_INVITE_VERSION } from "../pairing-invite";

/**
 * The desktop half of the pairing-QR contract.
 *
 * `apps/pocket/test/contract/fixtures_test.dart` asserts the other half against the
 * same file. Neither side is the authority — the fixture is — so a format change has
 * to be made deliberately in both places or one suite goes red.
 */
const fixture = JSON.parse(
  // Relative to apps/desktop, which is where vitest runs.
  readFileSync(path.join("..", "..", "contract", "fixtures", "pairing-invite.json"), "utf8"),
) as { host: string; port: number; code: string; address: string; uri: string };

describe("buildPairingInvite", () => {
  it("produces exactly the golden the phone parses", () => {
    expect(buildPairingInvite({ host: fixture.host, port: fixture.port, code: fixture.code }))
      .toBe(fixture.uri);
  });

  it("percent-encodes the colon, so the address survives as one parameter", () => {
    // Left bare, `192.168.1.11:8787` is still a legal query value in most parsers —
    // but not in all of them, and the phone's reader is the one that matters. Pinning
    // the encoding here is what keeps that from being discovered on a phone.
    expect(buildPairingInvite({ host: "10.0.0.4", port: 8787, code: "1" }))
      .toContain("address=10.0.0.4%3A8787");
  });

  it("brackets an IPv6 host so the port separator stays unambiguous", () => {
    // Unbracketed, the phone reads a host of `fd7a` and diagnoses the network for a
    // fault that was introduced right here.
    expect(buildPairingInvite({ host: "fd7a:1::2", port: 8787, code: "1" }))
      .toContain("address=%5Bfd7a%3A1%3A%3A2%5D%3A8787");
  });

  it("leaves an already-bracketed host alone", () => {
    expect(buildPairingInvite({ host: "[fd7a:1::2]", port: 8787, code: "1" }))
      .toContain("address=%5Bfd7a%3A1%3A%3A2%5D%3A8787");
  });

  it("declares the version the phone checks", () => {
    expect(buildPairingInvite({ host: "a", port: 1, code: "2" })).toContain(
      `v=${PAIRING_INVITE_VERSION}`,
    );
  });

  it("carries no host label — the pair reply is the source of truth for the name", () => {
    expect(buildPairingInvite({ host: "a", port: 1, code: "2" })).not.toContain("label");
  });
});
