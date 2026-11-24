import { afterEach, describe, expect, it } from "vitest";
import { focusCanvasNodeInput } from "../canvas-keyboard-guard";

/**
 * The reported symptom: after promoting an agent from the fleet rail, clicking that same row again
 * left the operator unable to type. The keyboard was sitting on the row's own button, because the
 * focus call had quietly failed and nothing checked.
 */
// The real document, not `createHTMLDocument`: `.focus()` does not move `activeElement` in a
// document that was never rendered, so a synthetic one cannot exercise the verification this helper
// exists for.
function board(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

afterEach(() => {
  document.body.innerHTML = "";
});

const node = (id: string, extra = "") =>
  `<div class="react-flow__node" data-id="${id}" ${extra}>
     <textarea class="xterm-helper-textarea"></textarea>
   </div>`;

describe("focusCanvasNodeInput", () => {
  it("focuses that node's own input", () => {
    const doc = board(node("a1"));

    expect(focusCanvasNodeInput("a1", doc)).toBe(true);
    expect(doc.activeElement).toBe(doc.querySelector(".xterm-helper-textarea"));
  });

  it("picks the right node when several are on the board", () => {
    const doc = board(node("a1") + node("a2"));

    focusCanvasNodeInput("a2", doc);

    expect(doc.activeElement?.closest(".react-flow__node")?.getAttribute("data-id")).toBe("a2");
  });

  it("refuses to fall back to some other node's input", () => {
    // The defect this replaces searched `document.body` when the id missed, so a stale or
    // mid-transition id sent the next keystroke into an agent the operator never chose — and a
    // veiled node is a candidate, which is worse still.
    const doc = board(node("a1"));

    expect(focusCanvasNodeInput("does-not-exist", doc)).toBe(false);
    expect(doc.activeElement).not.toBe(doc.querySelector(".xterm-helper-textarea"));
  });

  it("reports failure when the node has no input to focus", () => {
    const doc = board('<div class="react-flow__node" data-id="b1"></div>');

    expect(focusCanvasNodeInput("b1", doc)).toBe(false);
  });

  it("reports failure when the browser refuses the element", () => {
    // A veiled cell is `visibility: hidden`, and hidden elements are not focusable. `.focus()` is a
    // silent no-op there, which is exactly how the keyboard ended up stranded on a button.
    const doc = board(node("a1"));
    const target = doc.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
    Object.defineProperty(target, "focus", { value: () => {} });

    expect(focusCanvasNodeInput("a1", doc)).toBe(false);
  });

  it("takes an id that would break a CSS selector", () => {
    // Set as an attribute, the way React does — an innerHTML string cannot even carry this id.
    const doc = board(node("placeholder"));
    doc.querySelector(".react-flow__node")!.setAttribute("data-id", 'a"1');

    expect(focusCanvasNodeInput('a"1', doc)).toBe(true);
  });
});
