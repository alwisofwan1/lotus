import { describe, expect, it } from "vitest";

import { shownAddress } from "../ChatPreview";

describe("shownAddress", () => {
  it("shows a page in the chat's folder by its path there, anything else as it is", () => {
    expect(shownAddress("file:///repo/mockups/a%20b.html", "/repo/")).toBe("mockups/a b.html");
    expect(shownAddress("file:///elsewhere/a.html", "/repo")).toBe("/elsewhere/a.html");
    expect(shownAddress("http://localhost:3000/x", "/repo")).toBe("http://localhost:3000/x");
  });
});
