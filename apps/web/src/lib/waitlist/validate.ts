/**
 * The work-email rule.
 *
 * issues/06 decided the form asks for a *work* email rather than any email —
 * light qualification instead of raw volume, the pattern Linear used in its own
 * waitlist. That is a business rule, and it belongs here rather than in a
 * component or an HTML `pattern` attribute, because it needs a real list and a
 * real error message.
 *
 * Deliberately NOT a strict RFC 5322 implementation. The form's job is to catch
 * obvious mistakes and free providers; Buttondown's double opt-in is what actually
 * proves an address exists. Over-validating email is a classic way to reject real
 * people.
 */
import type { Rejection } from "./types";

/** Consumer providers. Not exhaustive and not meant to be — it covers the long
 *  tail of "I'll sign up with my personal address", which is the behaviour the
 *  rule exists to nudge, not to police. */
const FREE_PROVIDERS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.id",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "yandex.com",
  "qq.com",
  "163.com",
]);

const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export type Validated = { ok: true; email: string; domain: string } | { ok: false; rejection: Rejection };

export function validateWorkEmail(raw: string): Validated {
  const email = raw.trim().toLowerCase();

  if (email.length === 0) return { ok: false, rejection: { reason: "empty" } };
  if (!SHAPE.test(email)) return { ok: false, rejection: { reason: "malformed" } };

  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (FREE_PROVIDERS.has(domain)) {
    return { ok: false, rejection: { reason: "free-provider", provider: domain } };
  }

  return { ok: true, email, domain };
}

/** Reader-facing text for a rejection. Errors say what went wrong and how to fix
 *  it — no apologies, no vagueness. */
export function explain(rejection: Rejection): string {
  switch (rejection.reason) {
    case "empty":
      return "Enter your work email.";
    case "malformed":
      return "That does not look like an email address.";
    case "free-provider":
      return `${rejection.provider} is a personal address — the beta is small, so please use your work email.`;
  }
}
