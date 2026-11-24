import { describe, expect, it } from "vitest";
import { launchedProvider } from "../useFleetIdentitySync";

describe("launchedProvider", () => {
  it("names the agent a launch command starts", () => {
    expect(launchedProvider("pi")).toBe("pi");
    expect(launchedProvider("cursor-agent --yolo")).toBe("cursor");
    expect(launchedProvider("agy")).toBe("antigravity");
  });

  it("is null for a shell or a custom command", () => {
    expect(launchedProvider(undefined)).toBe(null);
    expect(launchedProvider("")).toBe(null);
    expect(launchedProvider("bun run dev")).toBe(null);
  });
});
