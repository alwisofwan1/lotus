import { describe, expect, it } from "vitest";
import { detectDesktopPlatform, isMacPlatform, isWindowsPlatform } from "@/lib/platform";

describe("detectDesktopPlatform", () => {
  it.each([
    ["MacIntel", "mac"],
    ["macOS", "mac"],
    ["iPad", "mac"],
    ["Win32", "windows"],
    ["Windows", "windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "windows"],
    ["Linux x86_64", "linux"],
    ["", "unknown"],
  ] as const)("reads %j as %s", (platform, expected) => {
    expect(detectDesktopPlatform(platform)).toBe(expected);
  });

  it("does not mistake darwin for Windows, which a bare /win/ would", () => {
    expect(isWindowsPlatform("darwin")).toBe(false);
  });

  it("answers mac only for a Mac", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });
});
