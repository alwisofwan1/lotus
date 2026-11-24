import { useRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDockedOccluder } from "./useDockedOccluder";
import {
  getDockedOccluderRects,
  __resetCanvasOcclusionForTests,
} from "../services/canvas-occlusion-store";

afterEach(() => {
  __resetCanvasOcclusionForTests();
});

function Dock({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDockedOccluder(ref, active);
  return <div ref={ref} data-testid="dock" />;
}

describe("useDockedOccluder", () => {
  it("registers a docked occluder while mounted and active", () => {
    const { unmount } = render(<Dock active />);
    expect(getDockedOccluderRects()).toHaveLength(1);

    unmount();
    expect(getDockedOccluderRects()).toHaveLength(0);
  });

  it("does not register while inactive", () => {
    render(<Dock active={false} />);
    expect(getDockedOccluderRects()).toHaveLength(0);
  });
});
