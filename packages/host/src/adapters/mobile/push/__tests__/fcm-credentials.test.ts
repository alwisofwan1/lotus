import { generateKeyPairSync, createVerify } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  FcmCredentials,
  resolveServiceAccountPath,
  SERVICE_ACCOUNT_FILE,
  type TokenFetcher,
} from "../fcm-credentials.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function serviceAccount(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "lotus-pocket",
    client_email: "pusher@lotus-pocket.iam.gserviceaccount.com",
    // Real Firebase files carry the PEM with escaped newlines.
    private_key: privateKey.replace(/\n/g, "\\n"),
    token_uri: "https://oauth2.googleapis.com/token",
    ...overrides,
  });
}

describe("resolveServiceAccountPath", () => {
  /**
   * The state-dir default is what makes push configurable at all on a desktop install.
   *
   * Lotus spawns the host runtime with an explicit allow-list environment
   * (`host_runtime/supervisor.rs::build_env`), and Lotus launched from Finder has no
   * shell environment — so `export LOTUS_FCM_SERVICE_ACCOUNT` in a terminal reaches
   * nothing. `LOTUS_STATE_DIR` *is* passed, and `api-server.key` and
   * `mobile-devices.json` already live there.
   */
  it("falls back to the state dir, beside the credentials already kept there", () => {
    expect(resolveServiceAccountPath(undefined, "/Users/op/.lotus")).toBe(
      `/Users/op/.lotus/${SERVICE_ACCOUNT_FILE}`,
    );
  });

  it("tolerates a trailing slash rather than producing a double one", () => {
    expect(resolveServiceAccountPath(undefined, "/Users/op/.lotus/")).toBe(
      `/Users/op/.lotus/${SERVICE_ACCOUNT_FILE}`,
    );
  });

  it("lets an explicit path win — a VPS has a shell and may keep the key elsewhere", () => {
    expect(resolveServiceAccountPath("/srv/secrets/fcm.json", "/root/.lotus")).toBe(
      "/srv/secrets/fcm.json",
    );
  });

  it("treats a blank env var as unset, not as an empty path", () => {
    expect(resolveServiceAccountPath("   ", "/Users/op/.lotus")).toBe(
      `/Users/op/.lotus/${SERVICE_ACCOUNT_FILE}`,
    );
  });
});

describe("FcmCredentials", () => {
  let dir: string;
  let clock: number;
  let requests: Array<{ uri: string; body: string }>;
  let reply: { status: number; text: string };
  let warnings: string[];

  const fetchToken: TokenFetcher = async (uri, body) => {
    requests.push({ uri, body });
    return reply;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-fcm-"));
    clock = 1_785_664_800_000;
    requests = [];
    warnings = [];
    reply = { status: 200, text: JSON.stringify({ access_token: "ya29.first", expires_in: 3600 }) };
  });

  function write(contents: string, mode = 0o600): string {
    const path = join(dir, "service-account.json");
    writeFileSync(path, contents);
    chmodSync(path, mode);
    return path;
  }

  function load(path: string | undefined): FcmCredentials | null {
    return FcmCredentials.load(path, {
      fetchToken,
      now: () => clock,
      warn: (message) => warnings.push(message),
    });
  }

  describe("when push is simply not configured", () => {
    it("returns null for an unset path, rather than failing to start", () => {
      // A Standalone Host on a VPS may have no Firebase project at all. `hostCaps`
      // exists to say so; refusing to boot would be the wrong answer.
      expect(load(undefined)).toBeNull();
      expect(load("   ")).toBeNull();
    });

    it("returns null when the file is not there", () => {
      expect(load(join(dir, "absent.json"))).toBeNull();
    });
  });

  describe("when the file is there but wrong", () => {
    it("names the fields that are missing, and the likely mistake", () => {
      // The most common one by far: downloading `google-services.json` (the *client*
      // config) instead of the service account key. Both are JSON, both come from the
      // Firebase console, and only one can sign.
      const path = write(JSON.stringify({ project_info: { project_id: "lotus" } }));

      expect(() => load(path)).toThrow(/missing project_id, client_email, private_key/);
      expect(() => load(path)).toThrow(/google-services\.json/);
    });

    it("refuses a file that is not JSON at all", () => {
      expect(() => load(write("not json"))).toThrow(/is not JSON/);
    });
  });

  describe("guarding the key material", () => {
    it("warns when the key is readable beyond its owner", () => {
      load(write(serviceAccount(), 0o644));

      // Warned, not refused: taking push away from an operator whose only fault is a
      // umask is worse than telling them to fix it.
      expect(warnings.join(" ")).toContain("chmod 600");
    });

    it("stays quiet for a key only its owner can read", () => {
      load(write(serviceAccount(), 0o600));

      expect(warnings).toEqual([]);
    });
  });

  describe("exchanging the key for an access token", () => {
    it("signs an assertion the public key verifies, for the messaging scope", async () => {
      const credentials = load(write(serviceAccount()))!;

      await credentials.accessToken();

      const assertion = new URLSearchParams(requests[0]!.body).get("assertion")!;
      const [header, claims, signature] = assertion.split(".");
      // Verified with the public half rather than merely checking the string is
      // three dot-separated parts: a broken signature looks identical until FCM
      // rejects it, at which point the failure is a 401 far from its cause.
      const verified = createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature!, "base64url"));
      expect(verified).toBe(true);

      const decoded = JSON.parse(Buffer.from(claims!, "base64url").toString("utf8"));
      expect(decoded.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
      expect(decoded.iss).toBe("pusher@lotus-pocket.iam.gserviceaccount.com");
    });

    it("caches the token instead of signing a JWT per notification", async () => {
      const credentials = load(write(serviceAccount()))!;

      expect(await credentials.accessToken()).toBe("ya29.first");
      expect(await credentials.accessToken()).toBe("ya29.first");

      expect(requests).toHaveLength(1);
    });

    it("renews before expiry, not after it", async () => {
      const credentials = load(write(serviceAccount()))!;
      await credentials.accessToken();
      reply = { status: 200, text: JSON.stringify({ access_token: "ya29.second", expires_in: 3600 }) };

      // 56 minutes in: still valid, but inside the renewal lead. Waiting for the
      // expiry would make a send race it.
      clock += 56 * 60 * 1000;

      expect(await credentials.accessToken()).toBe("ya29.second");
    });

    it("summarises a refusal rather than echoing the body", async () => {
      const credentials = load(write(serviceAccount()))!;
      reply = { status: 400, text: '{"error":"invalid_grant","client_email":"pusher@…"}' };

      // The response can carry the key's own identifiers, so the message says the
      // status and nothing else.
      await expect(credentials.accessToken()).rejects.toThrow(/failed with 400/);
      await expect(credentials.accessToken()).rejects.not.toThrow(/pusher@/);
    });

    it("refuses a 200 that carries no token", async () => {
      const credentials = load(write(serviceAccount()))!;
      reply = { status: 200, text: "{}" };

      await expect(credentials.accessToken()).rejects.toThrow(/no access_token/);
    });

    it("exposes the project id, which the send URL is built from", () => {
      expect(load(write(serviceAccount()))!.account.projectId).toBe("lotus-pocket");
    });
  });
});
