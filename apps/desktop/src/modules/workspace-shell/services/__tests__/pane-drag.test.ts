import { afterEach, describe, expect, it, vi } from "vitest";
import { beginPaneDrag } from "../pane-drag";

/** A pane on screen, as PaneCard draws it for the drag: its id and its workspace. */
function paneOnScreen(id: string, workspaceId = "w") {
  const el = document.createElement("section");
  el.dataset.paneId = id;
  el.dataset.paneSwapWs = workspaceId;
  document.body.appendChild(el);
  return el;
}

function dragOnto(target: Element, opts: { canSwap?: boolean; workspaceId?: string } = {}) {
  const source = paneOnScreen("a");
  const onDrop = vi.fn();
  vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
  beginPaneDrag(
    { button: 0, clientX: 0, clientY: 0, pointerId: 1, currentTarget: source },
    { label: "A", paneId: "a", workspaceId: opts.workspaceId ?? "w", fromFrameId: "f", canSwap: opts.canSwap, onDrop },
  );
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 30 }));
  const lit = target.getAttribute("data-drop");
  window.dispatchEvent(new MouseEvent("pointerup"));
  return { onDrop, lit };
}

describe("beginPaneDrag onto a pane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("swaps with the pane it is dropped on", () => {
    const { onDrop, lit } = dragOnto(paneOnScreen("b"), { canSwap: true });
    expect(lit).toBe("true");
    expect(onDrop).toHaveBeenCalledWith({ kind: "swap", paneId: "b" });
  });

  it("never swaps for a drag that cannot (a rail row), or across workspaces", () => {
    expect(dragOnto(paneOnScreen("b")).onDrop).not.toHaveBeenCalled();
    expect(dragOnto(paneOnScreen("b", "other"), { canSwap: true }).onDrop).not.toHaveBeenCalled();
  });
});
