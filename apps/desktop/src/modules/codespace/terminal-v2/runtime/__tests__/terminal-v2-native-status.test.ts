import { describe, expect, it, vi } from "vitest";
import { createTerminalV2NativeStatusNotifier } from "../terminal-v2-native-status";

describe("createTerminalV2NativeStatusNotifier", () => {
  it("emits status transitions with dedupe", () => {
    const onStatusChange = vi.fn();
    const notifier = createTerminalV2NativeStatusNotifier({ onStatusChange });

    expect(notifier.notify("starting")).toBe(true);
    expect(notifier.notify("starting")).toBe(false);
    expect(notifier.notify("live")).toBe(true);

    expect(onStatusChange.mock.calls.map((call) => call[0])).toEqual(["starting", "live"]);
    expect(notifier.getLastStatus()).toBe("live");
  });
});
