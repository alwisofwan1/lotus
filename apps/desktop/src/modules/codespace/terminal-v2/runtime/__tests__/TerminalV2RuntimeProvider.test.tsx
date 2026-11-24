import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalV2Runtime } from "../terminal-v2-runtime";
import {
  LOTUS_SETTINGS_CHANGED_EVENT,
} from "@/modules/settings/services/settings-events";
import {
  TerminalV2RuntimeProvider,
  useTerminalV2Runtime,
} from "../TerminalV2RuntimeProvider";

const terminalTheme = {
  background: "#050506",
  foreground: "#f7f2ea",
  cursor: "#f5f2ef",
};
const lightTerminalTheme = {
  background: "#fbfaf7",
  foreground: "#1c1b19",
  cursor: "#1c1b19",
};
let themeState: { theme: { terminal: typeof terminalTheme }; themeId: string } = {
  theme: { terminal: terminalTheme },
  themeId: "dark",
};
const getSettingsMock = vi.fn();
const createdRenderers: Array<{ dispose: ReturnType<typeof vi.fn>; setAppearance: ReturnType<typeof vi.fn> }> = [];
const loadDefaultPooledXtermRendererFactoryMock = vi.fn(async (options: unknown) => {
  void options;
  return vi.fn(() => {
    const renderer = {
      terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
      fitAddon: { fit: vi.fn() },
      dispose: vi.fn(),
      setAppearance: vi.fn(),
    };
    createdRenderers.push(renderer);
    return renderer;
  });
});
let tauri = false;

vi.mock("@/lib/tauri-api", () => ({
  getSettings: () => getSettingsMock(),
  isTauri: () => tauri,
}));

vi.mock("@/contexts/ThemeContext", () => ({
  useTheme: () => themeState,
}));

vi.mock("../../hooks/terminal-v2-pooled-renderer-loader", () => ({
  loadDefaultPooledXtermRendererFactory: (options: unknown) => loadDefaultPooledXtermRendererFactoryMock(options),
}));

function RuntimeProbe() {
  const runtime = useTerminalV2Runtime();
  return (
    <div>
      <span data-testid="feature-enabled">{String(runtime.featureEnabled)}</span>
      <span data-testid="pooled-renderer-enabled">{String(runtime.pooledRendererEnabled)}</span>
      <span data-testid="activation-requested">{String(runtime.activationRequested)}</span>
      <span data-testid="active">{String(runtime.active)}</span>
      <span data-testid="runtime-ready">{String(Boolean(runtime.runtime))}</span>
    </div>
  );
}

function RuntimeIdentityProbe({ onRuntime }: { onRuntime: (runtime: TerminalV2Runtime | null) => void }) {
  const runtime = useTerminalV2Runtime();
  onRuntime(runtime.runtime);
  return <span data-testid="runtime-identity-ready">{String(Boolean(runtime.runtime))}</span>;
}

describe("TerminalV2RuntimeProvider", () => {
  beforeEach(() => {
    tauri = false;
    themeState = { theme: { terminal: terminalTheme }, themeId: "dark" };
    createdRenderers.length = 0;
    getSettingsMock.mockReset();
    loadDefaultPooledXtermRendererFactoryMock.mockClear();
  });

  it("mounts at app level without activating runtime services before CodeSpace needs them", () => {
    render(
      <TerminalV2RuntimeProvider>
        <RuntimeProbe />
      </TerminalV2RuntimeProvider>,
    );

    expect(screen.getByTestId("feature-enabled")).toHaveTextContent("true");
    expect(screen.getByTestId("pooled-renderer-enabled")).toHaveTextContent("true");
    expect(screen.getByTestId("activation-requested")).toHaveTextContent("false");
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    expect(screen.getByTestId("runtime-ready")).toHaveTextContent("false");
  });

  it("activates once CodeSpace requests the app-level runtime", async () => {
    render(
      <TerminalV2RuntimeProvider activationRequested>
        <RuntimeProbe />
      </TerminalV2RuntimeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("true");
      expect(screen.getByTestId("runtime-ready")).toHaveTextContent("true");
    });
  });

  it("honors settings events so the default-on flag can fall back to legacy", async () => {
    render(
      <TerminalV2RuntimeProvider activationRequested>
        <RuntimeProbe />
      </TerminalV2RuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("runtime-ready")).toHaveTextContent("true"));

    window.dispatchEvent(new CustomEvent(LOTUS_SETTINGS_CHANGED_EVENT, {
      detail: { settings: { experimental: { terminalRuntimeV2: false, terminalV2PooledDomRenderer: false } } },
    }));

    await waitFor(() => {
      expect(screen.getByTestId("feature-enabled")).toHaveTextContent("false");
      expect(screen.getByTestId("pooled-renderer-enabled")).toHaveTextContent("false");
      expect(screen.getByTestId("active")).toHaveTextContent("false");
      expect(screen.getByTestId("runtime-ready")).toHaveTextContent("false");
    });
  });

  async function renderWithBoundPane() {
    tauri = true;
    getSettingsMock.mockResolvedValue({
      "terminal-font-size": 15,
      experimental: { terminalRuntimeV2: true, terminalV2PooledDomRenderer: true },
    });
    let runtime: TerminalV2Runtime | null = null;
    const view = render(
      <TerminalV2RuntimeProvider activationRequested>
        <RuntimeIdentityProbe onRuntime={(next) => { runtime = next ?? runtime; }} />
      </TerminalV2RuntimeProvider>,
    );
    await waitFor(() => expect(runtime).not.toBeNull());
    const paneContainer = document.createElement("div");
    runtime!.registerPooledRendererPaneContainer("pane-1", paneContainer);
    runtime!.updateRendererPane({ paneId: "pane-1", visible: true });
    await waitFor(() => expect(paneContainer.querySelector("[data-terminal-v2-slot-id]")).toBeTruthy());
    return { ...view, paneContainer };
  }

  it("gives pooled renderers the saved terminal font size", async () => {
    await renderWithBoundPane();

    await waitFor(() => {
      expect(createdRenderers[0]?.setAppearance).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 15 }));
    });
  });

  it("repaints the live renderer on a theme switch instead of rebuilding it", async () => {
    const { rerender, paneContainer } = await renderWithBoundPane();

    themeState = { theme: { terminal: lightTerminalTheme }, themeId: "light" };
    rerender(
      <TerminalV2RuntimeProvider activationRequested>
        <RuntimeIdentityProbe onRuntime={() => undefined} />
      </TerminalV2RuntimeProvider>,
    );

    await waitFor(() => {
      expect(createdRenderers[0]?.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ theme: expect.objectContaining({ background: lightTerminalTheme.background }) }),
      );
    });
    expect(createdRenderers[0]?.dispose).not.toHaveBeenCalled();
    expect(loadDefaultPooledXtermRendererFactoryMock).toHaveBeenCalledTimes(1);
    expect(paneContainer.querySelector("[data-terminal-v2-slot-id]")).toBeTruthy();
  });

  it("keeps the same app-level runtime while route children change", async () => {
    const seen: Array<TerminalV2Runtime | null> = [];
    const { rerender } = render(
      <TerminalV2RuntimeProvider activationRequested>
        <RuntimeIdentityProbe onRuntime={(runtime) => seen.push(runtime)} />
      </TerminalV2RuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("runtime-identity-ready")).toHaveTextContent("true"));
    const firstRuntime = seen.find(Boolean);

    rerender(
      <TerminalV2RuntimeProvider activationRequested>
        <div data-testid="route-child">CodeChat route placeholder</div>
        <RuntimeIdentityProbe onRuntime={(runtime) => seen.push(runtime)} />
      </TerminalV2RuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("route-child")).toBeInTheDocument());
    const latestRuntime = seen.filter(Boolean).at(-1);

    expect(latestRuntime).toBe(firstRuntime);
  });
});
