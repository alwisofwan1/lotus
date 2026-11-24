import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/** A phone's hardware key, as far as the host can tell: an EC P-256 pair. */
export interface TestRefreshKey {
  /** Base64 SPKI — what the phone sends at pairing. */
  publicKey: string;
  /** Signs like Android's `SHA256withECDSA`: DER, base64. */
  sign(payload: string): string;
}

export function testRefreshKey(curve = "prime256v1"): TestRefreshKey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: curve });
  return {
    publicKey: (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64"),
    sign: (payload) => signWith(privateKey, payload),
  };
}

function signWith(key: KeyObject, payload: string): string {
  return sign("sha256", Buffer.from(payload, "utf8"), { key, dsaEncoding: "der" }).toString("base64");
}
