import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseRefreshKey, renewalPayload, verifyRenewal } from "../refresh-key.js";
import { testRefreshKey } from "./support/refresh-keys.js";

describe("refresh key", () => {
  it("accepts an EC P-256 SubjectPublicKeyInfo", () => {
    expect(parseRefreshKey(testRefreshKey().publicKey)).not.toBeNull();
  });

  it("refuses another curve, another algorithm, and garbage", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ format: "der", type: "spki" }).toString("base64");

    expect(parseRefreshKey(testRefreshKey("secp384r1").publicKey)).toBeNull();
    expect(parseRefreshKey(rsa)).toBeNull();
    expect(parseRefreshKey("not a key")).toBeNull();
  });

  it("verifies a signature over the payload, and nothing else", () => {
    const key = testRefreshKey();
    const payload = renewalPayload("dev_1", "nonce-a");
    const signature = key.sign(payload);

    expect(verifyRenewal(key.publicKey, payload, signature)).toBe(true);
    expect(verifyRenewal(key.publicKey, renewalPayload("dev_1", "nonce-b"), signature)).toBe(false);
    expect(verifyRenewal(key.publicKey, renewalPayload("dev_2", "nonce-a"), signature)).toBe(false);
    expect(verifyRenewal(testRefreshKey().publicKey, payload, signature)).toBe(false);
    expect(verifyRenewal(key.publicKey, payload, "AAAA")).toBe(false);
  });

  it("separates its fields so one cannot bleed into the next", () => {
    expect(renewalPayload("dev_1", "x")).toBe("lotus-renew/v1\ndev_1\nx");
  });
});
