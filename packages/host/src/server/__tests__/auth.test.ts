import { describe, it, expect } from "vitest";

import { checkBearer } from "../auth.js";

const SECRET = "a".repeat(64);

describe("checkBearer", () => {
  it("accepts the exact bearer token", () => {
    expect(checkBearer(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(checkBearer(undefined, SECRET)).toBe(false);
  });

  it("rejects a header without the Bearer scheme", () => {
    expect(checkBearer(SECRET, SECRET)).toBe(false);
    expect(checkBearer(`Token ${SECRET}`, SECRET)).toBe(false);
  });

  it("rejects a wrong token of equal length", () => {
    expect(checkBearer(`Bearer ${"b".repeat(64)}`, SECRET)).toBe(false);
  });

  it("rejects a token of different length without throwing", () => {
    expect(checkBearer("Bearer short", SECRET)).toBe(false);
    expect(checkBearer(`Bearer ${SECRET}extra`, SECRET)).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(checkBearer("Bearer ", SECRET)).toBe(false);
  });
});
