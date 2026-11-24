import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchBrowserTab } from "@/modules/codespace/components/workbench/WorkbenchBrowserTab";

const useBrowserPaneRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => false,
}));

vi.mock("@/modules/codespace/hooks/useBrowserPaneRuntime", () => ({
  useBrowserPaneRuntime: useBrowserPaneRuntimeMock,
}));

describe("WorkbenchBrowserTab", () => {
  it("keeps the native webview alive while switching workbench tabs", () => {
    useBrowserPaneRuntimeMock.mockReturnValue({
      containerRef: vi.fn(),
    });

    render(
      <WorkbenchBrowserTab
        url="https://example.com"
        webviewLabel="codespace-pane-workbench-tab"
      />,
    );

    expect(useBrowserPaneRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        persistence: "keep-alive-hidden",
      }),
    );
  });
});
