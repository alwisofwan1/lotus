import { describe, expect, it, vi } from "vitest";
import { onOpenFactoryRunRequest, requestOpenFactoryRun } from "@/modules/factory/services/factory-open-request";

describe("asking the Factory to open a run (#146)", () => {
  it("hands a request to whoever listens", () => {
    const heard = vi.fn();
    const off = onOpenFactoryRunRequest(heard);
    requestOpenFactoryRun({ repo: "o/r", issue: 6 });
    expect(heard).toHaveBeenCalledWith({ repo: "o/r", issue: 6 });
    off();
    requestOpenFactoryRun({ repo: "o/r", issue: 7 });
    expect(heard).toHaveBeenCalledTimes(1);
    // Nobody heard #7 above; it is kept for the next listener, so clear it.
    onOpenFactoryRunRequest(() => {})();
  });

  it("keeps a request nobody heard for the first listener, once", () => {
    requestOpenFactoryRun({ repo: "o/r", issue: 8 });
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = onOpenFactoryRunRequest(first);
    const offSecond = onOpenFactoryRunRequest(second);
    expect(first).toHaveBeenCalledWith({ repo: "o/r", issue: 8 });
    expect(second).not.toHaveBeenCalled();
    offFirst();
    offSecond();
  });
});
