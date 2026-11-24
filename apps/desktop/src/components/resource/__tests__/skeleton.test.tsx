import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SkeletonDetail, SkeletonRows } from "@/components/resource/resource-kit";

describe("resource-kit skeletons", () => {
  it("SkeletonRows is a busy list with one row per count", () => {
    render(<SkeletonRows count={3} label="Loading runs" />);
    const list = screen.getByRole("list", { name: "Loading runs" });
    expect(list).toHaveAttribute("aria-busy", "true");
    expect(list.querySelectorAll(".rs-row--skeleton")).toHaveLength(3);
  });

  it("SkeletonDetail is a busy status in a page's shape: heading, meta and lines", () => {
    render(<SkeletonDetail label="Loading automation" />);
    const page = screen.getByRole("status", { name: "Loading automation" });
    expect(page).toHaveAttribute("aria-busy", "true");
    expect(page.querySelector(".rs-skel--heading")).not.toBeNull();
    expect(page.querySelectorAll(".rs-skel--line").length).toBeGreaterThan(1);
  });
});
