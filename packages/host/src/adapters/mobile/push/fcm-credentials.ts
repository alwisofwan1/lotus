import { createSign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** Google's OAuth2 token endpoint, and the one scope FCM v1 needs. */
const TOKEN_URI_FALLBACK = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** Access tokens last an hour; renew early so a send never races the expiry. */
const RENEW_LEAD_MS = 5 * 60 * 1000;

/** Signed assertions are short-lived by design — this is Google's own maximum. */
const ASSERTION_TTL_SEC = 3600;

/** Default file name inside the state dir, beside `api-server.key`. */
export const SERVICE_ACCOUNT_FILE = "fcm-service-account.json";

/**
 * The explicit path, else the state dir. The default is what makes push work on a desktop
 * install: the host gets an allow-list env (`supervisor.rs::build_env`) with `LOTUS_STATE_DIR`
 * but no shell exports. The env var stays first for a VPS.
 */
export function resolveServiceAccountPath(
  envPath: string | undefined,
  stateDir: string,
): string {
  const explicit = envPath?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return `${stateDir.replace(/\/$/, "")}/${SERVICE_ACCOUNT_FILE}`;
}

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export interface AccessToken {
  token: string;
  expiresAt: number;
}

/** The HTTP shape this module needs, injected so tests never reach the network. */
export type TokenFetcher = (
  uri: string,
  body: string,
) => Promise<{ status: number; text: string }>;

/**
 * **The private key never leaves this process or reaches the phone** (ADR-11): a leaked
 * service account key reaches every device. Hand-written instead of `firebase-admin` (one JWT,
 * one form POST) to keep megabytes out of the Tauri binary.
 */
export class FcmCredentials {
  private cached: AccessToken | null = null;

  private constructor(
    readonly account: ServiceAccount,
    private readonly fetchToken: TokenFetcher,
    private readonly now: () => number,
  ) {}

  /**
   * Null when push is not configured (ordinary; `hostCaps` reports it). A *malformed* file
   * is a misconfiguration, so it throws.
   */
  static load(
    filePath: string | undefined,
    opts: { fetchToken: TokenFetcher; now?: () => number; warn?: (message: string) => void },
  ): FcmCredentials | null {
    if (filePath === undefined || filePath.trim().length === 0) return null;

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return null;
    }

    // A key readable by other users on the box is a key to rotate, not a key to use
    // quietly. Warned rather than refused: refusing would take push away from an
    // operator whose only fault is a umask, and the warning is what makes it fixable.
    try {
      const mode = statSync(filePath).mode & 0o077;
      if (mode !== 0) {
        opts.warn?.(
          `FCM service account at ${filePath} is readable beyond its owner (mode ${mode.toString(8)}); chmod 600 it`,
        );
      }
    } catch {
      // Unreadable stat on a file we just read is not worth failing over.
    }

    const account = parseServiceAccount(raw, filePath);
    return new FcmCredentials(account, opts.fetchToken, opts.now ?? Date.now);
  }

  /** A valid bearer for FCM, minting a new one only when the cached one is near expiry. */
  async accessToken(): Promise<string> {
    const cached = this.cached;
    if (cached !== null && this.now() < cached.expiresAt - RENEW_LEAD_MS) return cached.token;

    const assertion = this.signAssertion();
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString();

    const reply = await this.fetchToken(this.account.tokenUri, body);
    if (reply.status !== 200) {
      // The response body can carry the key's own identifiers, so it is summarised
      // rather than echoed.
      throw new Error(`FCM token exchange failed with ${reply.status}`);
    }

    const parsed = JSON.parse(reply.text) as { access_token?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      throw new Error("FCM token exchange returned no access_token");
    }
    const lifetimeSec = typeof parsed.expires_in === "number" ? parsed.expires_in : ASSERTION_TTL_SEC;

    this.cached = {
      token: parsed.access_token,
      expiresAt: this.now() + lifetimeSec * 1000,
    };
    return this.cached.token;
  }

  /** RS256 JWT asserting "this service account, for this scope". */
  private signAssertion(): string {
    const issuedAt = Math.floor(this.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: this.account.clientEmail,
      scope: FCM_SCOPE,
      aud: this.account.tokenUri,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_TTL_SEC,
    };

    const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(this.account.privateKey)
      .toString("base64url");
    return `${signingInput}.${signature}`;
  }
}

function parseServiceAccount(raw: string, filePath: string): ServiceAccount {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`FCM service account at ${filePath} is not JSON`);
  }
  if (typeof json !== "object" || json === null) {
    throw new Error(`FCM service account at ${filePath} is not an object`);
  }

  const record = json as Record<string, unknown>;
  const projectId = str(record["project_id"]);
  const clientEmail = str(record["client_email"]);
  const privateKey = str(record["private_key"]);

  const missing = [
    projectId === undefined ? "project_id" : null,
    clientEmail === undefined ? "client_email" : null,
    privateKey === undefined ? "private_key" : null,
  ].filter((field): field is string => field !== null);

  if (missing.length > 0) {
    // Named fields, because "invalid credentials" sends the operator to look at the
    // wrong thing — usually Firebase's console rather than their own file.
    throw new Error(
      `FCM service account at ${filePath} is missing ${missing.join(", ")} — download the *service account* JSON, not google-services.json`,
    );
  }

  return {
    projectId: projectId!,
    clientEmail: clientEmail!,
    // JSON keeps the PEM's newlines escaped; `createSign` needs them real.
    privateKey: privateKey!.includes("\\n") ? privateKey!.replace(/\\n/g, "\n") : privateKey!,
    tokenUri: str(record["token_uri"]) ?? TOKEN_URI_FALLBACK,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
