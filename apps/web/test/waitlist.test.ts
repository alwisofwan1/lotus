/**
 * Tests for the only behaviour on the site.
 *
 * Everything here runs in Node with no DOM and no network — that is the evidence
 * the seam is in the right place. If a test in this file ever needs a browser, the
 * logic has leaked into the UI.
 */
import { describe, expect, it } from "vitest";
import {
  createWaitlist,
  createFormAdapter,
  createIframeAdapter,
  describeForm,
  explain,
  validateWorkEmail,
} from "../src/lib/waitlist";
import { createFakeAdapter } from "../src/lib/waitlist/adapters/fake";

describe("work-email rule", () => {
  it("accepts a company address and normalises it", () => {
    const result = validateWorkEmail("  Dev@Acme.Co  ");
    expect(result).toEqual({ ok: true, email: "dev@acme.co", domain: "acme.co" });
  });

  it("rejects empty input", () => {
    expect(validateWorkEmail("   ")).toEqual({ ok: false, rejection: { reason: "empty" } });
  });

  it.each(["nope", "no@domain", "@acme.co", "a b@acme.co", "two@@acme.co"])(
    "rejects malformed input: %s",
    (input) => {
      const result = validateWorkEmail(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.rejection.reason).toBe("malformed");
    },
  );

  it.each(["gmail.com", "outlook.com", "icloud.com", "proton.me", "qq.com"])(
    "rejects the consumer provider %s and names it",
    (provider) => {
      const result = validateWorkEmail(`someone@${provider}`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection).toEqual({ reason: "free-provider", provider });
      }
    },
  );

  it("accepts a subdomain that merely contains a provider name", () => {
    // gmail.com is blocked; mail.acme.co must not be.
    expect(validateWorkEmail("dev@mail.acme.co").ok).toBe(true);
  });

  it("explains every rejection in terms of what to do next", () => {
    expect(explain({ reason: "empty" })).toMatch(/work email/i);
    expect(explain({ reason: "malformed" })).toMatch(/email address/i);
    expect(explain({ reason: "free-provider", provider: "gmail.com" })).toContain("gmail.com");
  });
});

describe("prepare crosses the seam with the channel tag", () => {
  it("passes the validated email and channel to the adapter", () => {
    const fake = createFakeAdapter();
    const result = createWaitlist(fake).prepare({ email: "DEV@Acme.co", channel: "hero" });

    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual([{ email: "dev@acme.co", tag: "hero" }]);
  });

  it("never reaches the adapter when validation fails", () => {
    const fake = createFakeAdapter();
    const result = createWaitlist(fake).prepare({ email: "me@gmail.com", channel: "hero" });

    expect(result.ok).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it("carries the channel into the plan's hidden fields, so attribution is free", () => {
    const result = createWaitlist(createFormAdapter("lotus")).prepare({
      email: "dev@acme.co",
      channel: "reddit",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.hidden).toEqual([
        { name: "embed", value: "1" },
        { name: "tag", value: "reddit" },
      ]);
    }
  });
});

describe("the two shipping adapters differ only where they are supposed to", () => {
  const input = { email: "dev@acme.co", channel: "hero" } as const;
  const form = createWaitlist(createFormAdapter("lotus")).prepare(input);
  const iframe = createWaitlist(createIframeAdapter("lotus")).prepare(input);

  it("agree on the endpoint — same vendor, same account", () => {
    expect(form.ok && iframe.ok).toBe(true);
    if (form.ok && iframe.ok) {
      expect(form.plan.action).toBe(iframe.plan.action);
      expect(form.plan.action).toBe(
        "https://buttondown.com/api/emails/embed-subscribe/lotus",
      );
      expect(form.plan.method).toBe("post");
    }
  });

  it("differ on mode — that difference is the whole reason both exist", () => {
    if (form.ok && iframe.ok) {
      expect(form.plan.mode).toBe("navigate");
      expect(iframe.plan.mode).toBe("inline");
    }
  });

  it("never uses GET, which would put the address in a URL", () => {
    if (form.ok && iframe.ok) {
      expect(form.plan.method).toBe("post");
      expect(iframe.plan.method).toBe("post");
    }
  });
});

describe("describeForm renders the empty form without inventing a submission", () => {
  it("carries the channel tag before anyone has typed anything", () => {
    const plan = describeForm(createFormAdapter("lotus"), "footer");

    expect(plan.method).toBe("post");
    expect(plan.action).toBe("https://buttondown.com/api/emails/embed-subscribe/lotus");
    expect(plan.hidden).toEqual([
      { name: "embed", value: "1" },
      { name: "tag", value: "footer" },
    ]);
  });

  it("never leaks an email field into the hidden inputs", () => {
    const plan = describeForm(createFormAdapter("lotus"), "hero");
    expect(plan.hidden.map((f) => f.name)).not.toContain("email");
  });
});
