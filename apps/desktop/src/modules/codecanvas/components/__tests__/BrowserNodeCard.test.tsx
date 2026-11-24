import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createRef, type ComponentProps } from "react";
import { BrowserNodeCard } from "../nodes/BrowserNodeCard";

function renderCard(overrides: Partial<ComponentProps<typeof BrowserNodeCard>> = {}) {
  const props: ComponentProps<typeof BrowserNodeCard> = {
    browserNumber: 1,
    url: "https://example.com",
    browserState: "disconnected",
    containerRef: createRef<HTMLDivElement>(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onReload: vi.fn(),
    onNavigate: vi.fn(),
    viewportProfile: {
      mode: "auto",
      preset: "desktop",
      width: 1440,
      height: 900,
      orientation: "landscape",
      scaleMode: "fit",
      zoomFactor: 0.5,
      label: "Desktop",
    },
    ...overrides,
  };
  render(<BrowserNodeCard {...props} />);
  return props;
}

describe("BrowserNodeCard recovery state", () => {
  it("uses a custom browser label and commits inline renames", () => {
    const props = renderCard({
      label: "Preview",
      pageTitle: "Ignored page title",
      onRename: vi.fn(),
    });

    expect(screen.getByText("Preview")).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText("Preview"));
    const input = screen.getByRole("textbox", { name: /browser name/i });
    fireEvent.change(input, { target: { value: "Docs" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(props.onRename).toHaveBeenCalledWith("Docs");
  });

  it("uses the page title when no explicit browser label exists", () => {
    renderCard({ pageTitle: "Ghibli Grove" });

    expect(screen.getByText("Ghibli Grove")).toBeInTheDocument();
  });

  it("shows a retry affordance when the native browser runtime failed", () => {
    const props = renderCard({ nativeErrorReason: "webview not found" });

    expect(screen.getByText("Browser needs recovery")).toBeInTheDocument();
    expect(screen.getByText("webview not found")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry browser/i }));
    expect(props.onOpen).toHaveBeenCalledOnce();
  });

  it("keeps the normal reconnect copy when there is no native error", () => {
    renderCard();

    expect(screen.getByText("Browser closed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reconnect to example.com/i })).toBeInTheDocument();
  });
});

describe("BrowserNodeCard viewport controls", () => {
  it("lets users switch the browser viewport preset without leaving the node", () => {
    const props = renderCard({ browserState: "active", onViewportChange: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: /viewport and zoom/i }));
    fireEvent.click(screen.getByRole("button", { name: /use mobile viewport/i }));

    expect(props.onViewportChange).toHaveBeenCalledWith({
      viewportMode: "mobile",
      viewportScaleMode: "fit",
      viewportZoom: null,
    });
  });

  it("rotates the current viewport profile", () => {
    const props = renderCard({
      browserState: "active",
      viewportProfile: {
        mode: "tablet",
        preset: "tablet",
        width: 820,
        height: 1180,
        orientation: "portrait",
        scaleMode: "fit",
        zoomFactor: 0.5,
        label: "Tablet",
      },
      onViewportChange: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: /viewport and zoom/i }));
    fireEvent.click(screen.getByRole("button", { name: /rotate viewport/i }));

    expect(props.onViewportChange).toHaveBeenCalledWith({
      viewportOrientation: "landscape",
      viewportWidth: 1180,
      viewportHeight: 820,
    });
  });

  it("lets users zoom the browser viewport out", () => {
    const props = renderCard({ browserState: "active", onViewportChange: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: /viewport and zoom/i }));
    fireEvent.click(screen.getByRole("button", { name: /zoom out/i }));

    expect(props.onViewportChange).toHaveBeenCalledWith({
      viewportZoom: 0.4,
      viewportScaleMode: "actual",
    });
  });

  it("lets users return to fit zoom", () => {
    const props = renderCard({
      browserState: "active",
      viewportProfile: {
        mode: "desktop",
        preset: "desktop",
        width: 1440,
        height: 900,
        orientation: "landscape",
        scaleMode: "actual",
        zoomFactor: 0.7,
        label: "Desktop",
      },
      onViewportChange: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: /viewport and zoom/i }));
    fireEvent.click(screen.getByRole("button", { name: /fit viewport/i }));

    expect(props.onViewportChange).toHaveBeenCalledWith({
      viewportScaleMode: "fit",
      viewportZoom: null,
    });
  });
});

describe("BrowserNodeCard toolbar", () => {
  it("keeps the viewport row closed until the zoom chip opens it", () => {
    renderCard({ browserState: "active", onViewportChange: vi.fn() });

    expect(screen.queryByRole("button", { name: /zoom out/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /viewport and zoom/i })).toHaveTextContent("Fit · 50%");
  });

  it("picks from the toolbar and says Esc while picking", () => {
    const onAnnotate = vi.fn();
    renderCard({ browserState: "active", onAnnotate, annotationActive: true });

    const pick = screen.getByRole("button", { name: /stop picking/i });
    expect(pick).toHaveTextContent("PickingEsc");
    fireEvent.click(pick);
    expect(onAnnotate).toHaveBeenCalledOnce();
  });

  it("says in words why a pick was not sent", () => {
    renderCard({ browserState: "active", annotationDeliveryState: "failed", annotationDeliveryReason: "terminal-exited" });

    expect(screen.getByRole("status")).toHaveTextContent("Not sent: the terminal is closed");
  });
});
