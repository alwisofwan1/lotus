import { describe, expect, it } from "vitest";
import { isMonacoCancellationError } from "../monaco-cancellation";

function canceled(): Error {
  const error = new Error("Canceled");
  error.name = "Canceled";
  return error;
}

describe("isMonacoCancellationError", () => {
  it("matches Monaco's CancellationError: name and message both 'Canceled'", () => {
    expect(isMonacoCancellationError(canceled())).toBe(true);
  });

  it("does not match other errors that merely mention cancelling", () => {
    const named = new Error("Request failed");
    named.name = "Canceled";
    expect(isMonacoCancellationError(named)).toBe(false);
    expect(isMonacoCancellationError(new Error("Canceled"))).toBe(false);
    expect(isMonacoCancellationError("Canceled")).toBe(false);
    expect(isMonacoCancellationError({ name: "Canceled", message: "Canceled" })).toBe(false);
    expect(isMonacoCancellationError(null)).toBe(false);
  });
});
