import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  LiveVoiceStatusProvider,
  useLiveVoiceActive,
  useLiveVoiceStatusState,
  useReportLiveVoiceActive,
} from "../live-voice-status";

// Seam: the Live Voice status context. The session owner (the command bar) reports; any reader in
// the same subtree (narration, Speaker Queue hold) sees it. No module-global flag.

function Reporter({ active }: { active: boolean }) {
  useReportLiveVoiceActive(active);
  return null;
}

function Reader() {
  return <span data-testid="reader">{useLiveVoiceActive() ? "live" : "quiet"}</span>;
}

function Owner({ children }: { children: (ownerActive: boolean) => React.ReactNode }) {
  const status = useLiveVoiceStatusState();
  return <LiveVoiceStatusProvider value={status.value}>{children(status.active)}</LiveVoiceStatusProvider>;
}

function Harness() {
  const [active, setActive] = useState(false);
  const [mounted, setMounted] = useState(true);
  return (
    <Owner>
      {(ownerActive) => (
        <>
          <span data-testid="owner">{ownerActive ? "live" : "quiet"}</span>
          {mounted && <Reporter active={active} />}
          <Reader />
          <button onClick={() => setActive((a) => !a)}>toggle</button>
          <button onClick={() => setMounted(false)}>unmount</button>
        </>
      )}
    </Owner>
  );
}

describe("Live Voice status context", () => {
  it("a report from the session owner reaches the provider owner and every reader", () => {
    render(<Harness />);
    expect(screen.getByTestId("owner").textContent).toBe("quiet");
    act(() => screen.getByText("toggle").click());
    expect(screen.getByTestId("owner").textContent).toBe("live");
    expect(screen.getByTestId("reader").textContent).toBe("live");
    act(() => screen.getByText("toggle").click());
    expect(screen.getByTestId("reader").textContent).toBe("quiet");
  });

  it("goes quiet when the reporting session unmounts while live", () => {
    render(<Harness />);
    act(() => screen.getByText("toggle").click());
    act(() => screen.getByText("unmount").click());
    expect(screen.getByTestId("owner").textContent).toBe("quiet");
  });

  it("is quiet, and reporting is harmless, with no provider", () => {
    render(
      <>
        <Reporter active />
        <Reader />
      </>,
    );
    expect(screen.getByTestId("reader").textContent).toBe("quiet");
  });
});
