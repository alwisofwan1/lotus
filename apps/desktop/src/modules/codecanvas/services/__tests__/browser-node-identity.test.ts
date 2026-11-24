import { describe, expect, it } from "vitest";
import { browserAliases, browserDefaultName, browserDisplayName, browserHost, browserRegistryEntry, normalizeBrowserLabel } from "../browser-node-identity";

describe("browser-node identity", () => {
  it("uses label, page title, host, then Browser N as the display-name precedence", () => {
    expect(browserDisplayName({
      browserNumber: 2,
      label: " Docs ",
      pageTitle: "Ignored page title",
      url: "https://ignored.example/app",
    })).toBe("Docs");
    expect(browserDisplayName({
      browserNumber: 2,
      label: " ",
      pageTitle: " Ghibli Grove ",
      url: "https://ignored.example/app",
    })).toBe("Ghibli Grove");
    expect(browserDisplayName({
      browserNumber: 2,
      label: "",
      pageTitle: " ",
      url: "https://example.com/app",
    })).toBe("example.com");
    expect(browserDisplayName({
      browserNumber: 2,
      label: "",
      pageTitle: "",
      url: "about:blank",
    })).toBe("Browser 2");
    expect(browserDefaultName(undefined)).toBe("Browser 1");
  });

  it("keeps stable aliases for voice and agents", () => {
    expect(browserAliases({ browserNumber: 1, label: "Preview", url: "https://localhost.test/app" })).toEqual([
      "Preview",
      "Browser 1",
      "localhost.test",
    ]);
  });

  it("normalizes labels and hosts for registry entries", () => {
    expect(normalizeBrowserLabel("  Local   App  ", "Browser 1")).toBe("Local App");
    expect(browserHost("https://tailwindcss.com/docs/installation")).toBe("tailwindcss.com");
    expect(browserRegistryEntry("b1", { browserNumber: 1, label: "Docs", url: "https://tailwindcss.com", state: "active" })).toMatchObject({
      id: "b1",
      name: "Docs",
      state: "active",
      host: "tailwindcss.com",
    });
  });
});
