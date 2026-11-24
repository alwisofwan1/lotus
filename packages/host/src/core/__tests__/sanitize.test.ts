import { describe, it, expect } from "vitest";

import { sanitizeArgs } from "../sanitize.js";

describe("sanitizeArgs", () => {
  it("redacts password= values", () => {
    expect(sanitizeArgs("password=hunter2")).toBe("password=***");
  });

  it("leaves non-secret args untouched", () => {
    expect(sanitizeArgs("ls -la /tmp")).toBe("ls -la /tmp");
  });

  it("only redacts the secret value, preserving following words", () => {
    expect(sanitizeArgs("token=abc123 --other-flag")).toBe("token=*** --other-flag");
  });

  it("redacts every recognized pattern independently", () => {
    expect(sanitizeArgs("--key=foo --secret=bar")).toBe("--key=*** --secret=***");
  });

  it("matches case-insensitively", () => {
    expect(sanitizeArgs("APIKEY=xyz")).toBe("APIKEY=***");
  });

  it("does not redact substrings inside other words", () => {
    expect(sanitizeArgs("readonlykey=safe")).toBe("readonlykey=safe");
  });
});
