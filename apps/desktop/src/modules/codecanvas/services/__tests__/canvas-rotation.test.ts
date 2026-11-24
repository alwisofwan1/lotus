import { describe, expect, it } from "vitest";
import { normalizeAngle, rotationFromPointer } from "../canvas-rotation";

describe("normalizeAngle", () => {
  it("wraps any input into [0, 360)", () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(370)).toBe(10);
    expect(normalizeAngle(-30)).toBe(330);
    expect(normalizeAngle(-390)).toBe(330);
  });
});

describe("rotationFromPointer", () => {
  const center = { x: 100, y: 100 };

  it("maps the pointer straight above the center to 0°", () => {
    expect(rotationFromPointer(center, { x: 100, y: 40 })).toBe(0);
  });

  it("maps right to 90°, below to 180°, left to 270°", () => {
    expect(rotationFromPointer(center, { x: 160, y: 100 })).toBe(90);
    expect(rotationFromPointer(center, { x: 100, y: 160 })).toBe(180);
    expect(rotationFromPointer(center, { x: 40, y: 100 })).toBe(270);
  });

  it("returns fractional angles for in-between positions", () => {
    const angle = rotationFromPointer(center, { x: 160, y: 40 }); // up-right diagonal
    expect(angle).toBeCloseTo(45, 5);
  });

  it("snaps to 15° increments when asked (Shift held)", () => {
    expect(rotationFromPointer(center, { x: 160, y: 42 }, { snap: 15 })).toBe(45);
    expect(rotationFromPointer(center, { x: 101, y: 40 }, { snap: 15 })).toBe(0);
    // wraps: just left of straight-up snaps to 0, not 360
    expect(rotationFromPointer(center, { x: 99, y: 40 }, { snap: 15 })).toBe(0);
  });
});
