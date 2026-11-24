import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FleetSettingsSection } from "@/modules/settings/components/FleetSettingsSection";
import type { ClaudeSettings } from "@/modules/settings/types";

/**
 * The section that replaced 573 lines of settings for a retired feature.
 *
 * What is checked is the promise a settings page makes: every control writes something, and a
 * write does not throw away what it did not touch.
 */

const debounceField = () => screen.getByRole("spinbutton", { name: "Fleet push debounce" });

// The stepper commits a typed value on blur, not per keystroke.
const type = (value: string) => {
  const field = debounceField();
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

const legacy = {
  bridge: {
    persona: { mode: "preset" },
    notifications: { enabled: true },
    orchestration: { fleetPushDebounceMs: 250, includeExitedInFleet: true },
  },
} as unknown as ClaudeSettings;

describe("FleetSettingsSection", () => {
  it("shows the stored values", () => {
    render(<FleetSettingsSection settings={legacy} update={vi.fn()} />);
    expect(debounceField()).toHaveValue("250");
  });

  it("writes the field someone changed", () => {
    const update = vi.fn();
    render(<FleetSettingsSection settings={legacy} update={update} />);

    type("400");

    const patch = update.mock.calls[0][0] as { bridge: { orchestration: Record<string, unknown> } };
    expect(patch.bridge.orchestration.fleetPushDebounceMs).toBe(400);
  });

  it("steps the debounce by its real step", () => {
    const update = vi.fn();
    render(<FleetSettingsSection settings={legacy} update={update} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Increase Fleet push debounce" }), { button: 0 });
    fireEvent.pointerUp(screen.getByRole("button", { name: "Increase Fleet push debounce" }));

    const patch = update.mock.calls[0][0] as { bridge: { orchestration: Record<string, unknown> } };
    expect(patch.bridge.orchestration.fleetPushDebounceMs).toBe(275);
  });

  /*
    The file still holds persona and notifications for features that are gone. This section no
    longer READS them, which is not a licence to erase them: a settings editor that drops what it
    does not understand is how one app's cleanup becomes another's data loss.
  */
  it("keeps the blocks it no longer reads", () => {
    const update = vi.fn();
    render(<FleetSettingsSection settings={legacy} update={update} />);

    type("0");

    const patch = update.mock.calls[0][0] as { bridge: Record<string, unknown> };
    expect(patch.bridge).toHaveProperty("persona");
    expect(patch.bridge).toHaveProperty("notifications");
  });

  it("puts the defaults back", () => {
    const update = vi.fn();
    render(<FleetSettingsSection settings={legacy} update={update} />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    const patch = update.mock.calls[0][0] as { bridge: { orchestration: Record<string, unknown> } };
    expect(patch.bridge.orchestration).toMatchObject({
      fleetPushDebounceMs: 150,
      forceFleetSnapshotOnSpawn: true,
      includeExitedInFleet: false,
    });
  });
});
