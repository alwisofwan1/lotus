import { describe, expect, it } from "vitest";
import { pathToOpenOnEnter } from "../file-node-enter";

const file = { id: "f", type: "file", position: { x: 0, y: 0 }, data: { path: "/repo/a.ts" } };

describe("pathToOpenOnEnter (⏎ on the selected node, canvas layer)", () => {
  it("gives the path of a selected File Node", () => {
    expect(pathToOpenOnEnter(file, null)).toBe("/repo/a.ts");
  });
  it("gives nothing for any other node, so ⏎ keeps diving into it", () => {
    expect(pathToOpenOnEnter({ ...file, type: "terminal" }, null)).toBeNull();
    expect(pathToOpenOnEnter(undefined, null)).toBeNull();
  });
  it("gives nothing for a File Node without a usable path", () => {
    expect(pathToOpenOnEnter({ ...file, data: {} }, null)).toBeNull();
  });
  it("leaves ⏎ to a focused button, which activates itself", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    expect(pathToOpenOnEnter(file, button)).toBeNull();
    button.remove();
  });
});
