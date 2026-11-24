import { describe, it, expect } from "vitest";
import { startupWarnings } from "../startup-warnings.js";

describe("startupWarnings", () => {
  it("warns a standalone host that it cannot wake the phone", () => {
    // events.ts calls a silently unwakeable host "the worst failure mode in this product",
    // and a VPS is exactly where nobody is sitting to notice.
    const warnings = startupWarnings({ mode: "standalone", fcmServiceAccountPath: undefined });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/approval/i);
  });

  // Guards for the boundaries, so the warning cannot creep outside the case it was written for.
  it("stays quiet once push credentials are configured", () => {
    expect(startupWarnings({ mode: "standalone", fcmServiceAccountPath: "/etc/fcm.json" }))
      .toEqual([]);
  });

  it("stays quiet in client mode, where a desktop the operator is using relays instead", () => {
    expect(startupWarnings({ mode: "client", fcmServiceAccountPath: undefined })).toEqual([]);
  });
});
