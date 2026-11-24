import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => "/settings",
}));

import { LotusSettingsProvider } from "../lotus-settings-context";
import { LegacySettingsRoute } from "../components/LegacySettingsRoute";
import { settingsSectionStub } from "../testing/settings-section-stub";
import { LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY } from "@/modules/shell/services/last-shell-destination";

const SECTIONS = [
  settingsSectionStub("lotus", "general"),
  settingsSectionStub("lotus", "about"),
  settingsSectionStub("chat", "chat"),
];

function visit(search: string) {
  nav.search = search;
  render(<LotusSettingsProvider sections={SECTIONS}><LegacySettingsRoute /></LotusSettingsProvider>);
  return screen.getByRole("dialog");
}

beforeEach(() => {
  localStorage.clear();
  nav.replace.mockReset();
});

describe("the old /settings URL", () => {
  it("opens Lotus Settings on the section it names and goes back to where the user was", () => {
    localStorage.setItem(LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY, "/canvas");
    const dialog = visit("?section=codechat");

    expect(within(dialog).getByText("chat body")).toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith("/canvas");
  });

  it("sends a retired section id to its new home", () => {
    const dialog = visit("?section=ssh-right-panel");
    expect(within(dialog).getByText("about body")).toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith("/");
  });

  it("opens Lotus Settings when no section is named", () => {
    const dialog = visit("");
    expect(within(dialog).getByText("general body")).toBeInTheDocument();
  });
});
