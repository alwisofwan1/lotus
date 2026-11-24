import { describe, expect, it } from "vitest";
import { download } from "../src/copy";
import { readFileSync } from "node:fs";

// The browser file is a classic script (CSP-safe, render-blocking); load its function here.
const pickOs = new Function(
  `${readFileSync(new URL("../public/download-os.js", import.meta.url), "utf8")}; return pickOs;`,
)() as (platform: string, ua: string, touch: number) => "mac" | "win" | null;

describe("download links", () => {
  it("point at the stable latest-release names", () => {
    const base = "https://github.com/alwisofwan1/lotus-releases/releases";
    expect(download.mac.href).toBe(`${base}/latest/download/Lotus-macos-arm64.dmg`);
    expect(download.win.href).toBe(`${base}/latest/download/Lotus-windows-x64-setup.exe`);
    expect(download.all.href).toBe(base);
  });
});

describe("pickOs", () => {
  const ua = {
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
    win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
    linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",
  };
  it.each([
    ["macOS", "", ua.mac, 0, "mac"],
    ["Client Hints macOS", "macOS", ua.mac, 0, "mac"],
    ["Windows", "Windows", ua.win, 0, "win"],
    ["Linux", "Linux", ua.linux, 0, null],
    ["iPhone", "", ua.iphone, 5, null],
    ["iPadOS posing as a Mac", "", ua.mac, 5, null],
    ["Android", "Android", ua.android, 5, null],
  ] as const)("%s", (_, platform, agent, touch, want) => {
    expect(pickOs(platform, agent, touch)).toBe(want);
  });
});
