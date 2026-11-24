import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FactoryStageBar } from "@/modules/factory/components/FactoryStageBar";

const at = (stage: "building" | "checking") => ({ stage, attempt: 2, maxAttempts: 2, steps: [] });

describe("FactoryStageBar", () => {
  it("only the stage being worked on carries the moving front", () => {
    const { container } = render(<FactoryStageBar progress={at("building")} state="running" />);
    const fronts = [...container.querySelectorAll(".fa-seg-svg[data-front]")].map((svg) => svg.closest("li")?.getAttribute("data-status"));
    expect(fronts).toEqual(["active"]);
  });

  it("a failed check is drawn failed, not as waiting on you", () => {
    const { container } = render(<FactoryStageBar progress={at("checking")} state="check-failed" />);
    expect(container.querySelector('.fa-bar-seg[data-status="failed"]')?.textContent).toBe("Check");
    expect(container.querySelector(".fa-seg-svg[data-front]")).toBeNull();
  });

  it("sizes the strip from pixel × rows and keeps pattern ids unique per bar", () => {
    const { container } = render(
      <>
        <FactoryStageBar progress={at("building")} state="running" pixel={6} rows={4} />
        <FactoryStageBar progress={at("building")} state="running" />
      </>,
    );
    const [big, small] = [...container.querySelectorAll<HTMLElement>(".fa-bar")];
    expect(big.style.getPropertyValue("--fa-strip-h")).toBe("24px");
    expect(small.style.getPropertyValue("--fa-strip-h")).toBe("9px");
    const ids = [...container.querySelectorAll("pattern")].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-zA-Z0-9-]+$/.test(id))).toBe(true);
  });
});
