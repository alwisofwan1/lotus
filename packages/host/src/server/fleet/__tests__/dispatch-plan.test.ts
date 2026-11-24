import { describe, expect, it } from "vitest";

import { dispatchWritePlan, SUBMIT_DELAY_MS } from "../dispatch-plan.js";

/**
 * Measured on devbox-vps 2026-09-05, from a real phone: a dispatch of "Hi" to a Codex cell
 * put `› Hi` in the composer and left it there. The text arrived; the newline that came with
 * it did not submit anything. A bare CR sent afterwards submitted it immediately.
 *
 * The desktop has known this since 2026-08-06 (`build_dispatch_write_plan` in `mcp_ipc.rs`):
 * a TUI swallows a paste that carries its own Enter. The standalone host wrote
 * `${command}\n` in one call and never got the fix.
 */
describe("dispatchWritePlan", () => {
  it("sends the body and the submit key as two writes", () => {
    const plan = dispatchWritePlan("run the tests", true);

    expect(plan.writes).toEqual(["run the tests", "\r"]);
    expect(plan.delayBeforeSubmitMs).toBe(SUBMIT_DELAY_MS);
  });

  /** CR, not LF: it is the Enter key, and a TUI reads the key rather than the character. */
  it("submits with a carriage return", () => {
    expect(dispatchWritePlan("x", true).writes[1]).toBe("\r");
  });

  it("strips a line ending the caller already put on, rather than sending two", () => {
    expect(dispatchWritePlan("hello\n", true).writes).toEqual(["hello", "\r"]);
    expect(dispatchWritePlan("hello\r\n", true).writes).toEqual(["hello", "\r"]);
    expect(dispatchWritePlan("hello\r", true).writes).toEqual(["hello", "\r"]);
  });

  /** Only the trailing one. A multi-line paste keeps its own shape. */
  it("keeps the newlines inside a multi-line body", () => {
    expect(dispatchWritePlan("first\nsecond\n", true).writes[0]).toBe("first\nsecond");
  });

  it("sends one write and no submit when the caller says not to append", () => {
    const plan = dispatchWritePlan("no enter please", false);

    expect(plan.writes).toEqual(["no enter please"]);
    expect(plan.delayBeforeSubmitMs).toBe(0);
  });

  /** What the route reports as written — the submit key counts, the stripped one does not. */
  it("counts the bytes it will actually write", () => {
    expect(dispatchWritePlan("abc\n", true).bytes).toBe(4);
    expect(dispatchWritePlan("abc", false).bytes).toBe(3);
  });

  it("handles an empty body without inventing a write", () => {
    expect(dispatchWritePlan("", true).writes).toEqual(["", "\r"]);
  });
});
