/**
 * The desktop app's privacy policy, held to the desktop code in both directions.
 *
 * This page is what Google's OAuth consent screen links to (plans/google-connector, ADR-0044),
 * and Google reviews it against what the app asks for. Every factual sentence is a property of
 * `apps/desktop` — the scopes, what is read from a sheet, where the token lives, that Disconnect
 * revokes, that the agent never holds the token. Change one of those files and this page becomes
 * a false statement on a legal page with nothing failing, unless this file fails.
 *
 * Same deliberate ADR-0011 exception as `facts-match-source.test.ts`: read-only, test-only, by
 * path. Nothing here reaches `dist/`.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { footer, privacy, privacyDesktop } from "../src/copy";

function repoRoot(): string {
  let dir = resolve(dirname(new URL(import.meta.url).pathname));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("repo root not found — is this running outside the repo?");
}

const ROOT = repoRoot();
const read = (rel: string) => {
  const full = join(ROOT, rel);
  if (!existsSync(full)) throw new Error(`Cited source is missing: ${rel} — re-derive the sentence, do not delete the test.`);
  return readFileSync(full, "utf8");
};
const GOOGLE = "apps/desktop/src-tauri/crates/lotus-automation/src/google";
const AUTH = read(`${GOOGLE}/auth.rs`);
const API = read(`${GOOGLE}/api.rs`);
const HOST = read("apps/desktop/src-tauri/src/automation_google.rs");
const SLACK_HOST = read("apps/desktop/src-tauri/src/automation_slack.rs");
const AGENT = read("apps/desktop/src-tauri/crates/lotus-automation/src/agent.rs");

const POLICY = [privacyDesktop.intro, ...privacyDesktop.sections.flatMap((s) => [s.heading, ...s.body])].join("\n");

describe("the policy asks for exactly the Google permissions the app asks for", () => {
  const scopes = /pub const SCOPES: &\[&str\] = &\[([^\]]*)\]/.exec(AUTH)?.[1] ?? "";

  it("finds the app's scope list", () => {
    expect(scopes, "SCOPES not found in auth.rs").not.toBe("");
  });

  it("names openid, email and drive.file while the app asks for them", () => {
    for (const scope of ["openid", "email"]) {
      expect(scopes.includes(`"${scope}"`), `auth.rs no longer asks for ${scope}`).toBe(true);
      expect(POLICY).toContain(`\`${scope}\``);
    }
    expect(AUTH).toContain('SCOPE_DRIVE_FILE: &str = "https://www.googleapis.com/auth/drive.file"');
    expect(POLICY).toContain("`drive.file`");
  });

  it("names no Google scope the app does not ask for", () => {
    const broader = /auth\/(drive(?!\.file)|spreadsheets|documents|gmail)/;
    expect(
      broader.test(AUTH),
      "auth.rs asks for a broader Google scope. The policy says only drive.file — and a broader scope " +
        "also means Google's sensitive or restricted review. Update both, deliberately.",
    ).toBe(false);
  });
});

describe("the policy describes what the app does and not a different app", () => {
  it("discloses reading a sheet's first row exactly while the app reads it", () => {
    const readsHeader = /pub async fn header_row/.test(API);
    expect(/first row of a tab/.test(POLICY), readsHeader ? "api.rs reads a header row; say so" : "api.rs no longer reads a header row; stop saying it").toBe(readsHeader);
  });

  it("says the Picker is Google's own, with drive.file alone, while it is", () => {
    expect(AUTH).toMatch(/append_pair\("trigger_onepick", "true"\)/);
    expect(AUTH).toMatch(/append_pair\("scope", SCOPE_DRIVE_FILE\)/);
    expect(POLICY).toMatch(/pick in Google's own Picker/);
  });

  it("keeps the token in the macOS Keychain while the store is the keychain", () => {
    expect(HOST).toContain("crate::automation_slack::secret_store()");
    expect(SLACK_HOST).toContain("keyring::v1::Entry");
    expect(POLICY).toMatch(/macOS Keychain/);
  });

  it("promises Disconnect revokes at Google while disconnect calls revoke", () => {
    const disconnect = HOST.slice(HOST.indexOf("pub async fn disconnect"));
    expect(disconnect, "disconnect no longer revokes the grant at Google").toMatch(/revoke\(/);
    expect(POLICY).toMatch(/revokes the token/);
  });

  it("says the agent never receives the Google token while no agent code touches Google", () => {
    expect(/google/i.test(AGENT), "agent.rs now references Google — re-check what the agent can reach").toBe(false);
    expect(POLICY).toMatch(/never receives the Google token/);
  });

  it("never claims data stays on the computer", () => {
    expect(POLICY).not.toMatch(/(never|does not|doesn't)\s+leave[s]?\s+your\s+(machine|computer|device|Mac)/i);
  });
});

describe("Google's required disclosure is present word for word", () => {
  it("carries the Limited Use statement", () => {
    expect(POLICY).toContain(
      "use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements",
    );
    expect(POLICY).toContain("https://developers.google.com/terms/api-services-user-data-policy");
  });
});

describe("the page exists, is reachable, and keeps its placeholders visible", () => {
  const WEB = "apps/web/src";

  it("is a built page, linked from the website notice, and in the sitemap", () => {
    expect(existsSync(join(ROOT, `${WEB}/pages/privacy/desktop.astro`))).toBe(true);
    expect(privacy.desktop.href).toBe("/privacy/desktop/");
    expect(read(`${WEB}/pages/privacy.astro`)).toContain("privacy.desktop.href");
    expect(read(`${WEB}/pages/sitemap.xml.ts`)).toContain('"/privacy/desktop/"');
  });

  it("names a real controller and contact, with no placeholder left", () => {
    const found = [...POLICY.matchAll(/<[a-z][^>]*>/g)].map((m) => m[0]);
    expect(found, "Google reviews this page: every placeholder must be filled with a real value").toEqual([]);
    expect(POLICY).toMatch(/controller of your data is Alwi Sofwan/);
  });

  it("gives the same contact email as the support email on Google's consent screen", () => {
    // Set in Google Cloud → Branding for project lotus-510006 on 2026-09-28. Change both together.
    expect(POLICY.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)).toEqual(["dev@example.com", "dev@example.com"]);
  });
});

describe("the homepage links this policy", () => {
  it("has a footer link to /privacy/desktop/, which Google's brand verification checks", () => {
    // Failed review 2026-09-29: "Your home page does not include a link to your privacy policy" —
    // the homepage linked only the website notice (/privacy/), not the policy the consent screen names.
    expect(footer.links.map((l) => l.href)).toContain("/privacy/desktop/");
    expect(read("apps/web/src/components/SiteFooter.astro")).toContain("footer.links.map");
  });
});
