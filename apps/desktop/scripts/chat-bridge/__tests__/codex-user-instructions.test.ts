import { describe, expect, it } from "vitest";

import { withUserInstructions } from "../codex-session";

describe("withUserInstructions", () => {
  it("keeps the user's Codex developer_instructions ahead of Lotus's note", () => {
    expect(withUserInstructions("Answer in Indonesian.", "LOTUS")).toBe("Answer in Indonesian.\n\nLOTUS");
  });

  it("is only Lotus's note when the user set none", () => {
    expect(withUserInstructions(null, "LOTUS")).toBe("LOTUS");
  });
});
