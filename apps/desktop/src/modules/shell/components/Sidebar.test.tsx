import type { AnchorHTMLAttributes, ImgHTMLAttributes } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { LotusSettingsProvider } from "@/modules/lotus-settings/lotus-settings-context";
import { settingsSectionStub } from "@/modules/lotus-settings/testing/settings-section-stub";

const mockPush = vi.fn();
const mockSidebarState = {
  collapsed: false,
  toggle: vi.fn(),
};

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => <img {...props} alt={props.alt ?? ""} />,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/teams",
}));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => false,
  openNewWindow: vi.fn(),
}));

vi.mock("@/modules/shell/containers/AppShell", () => ({
  useSidebar: () => mockSidebarState,
}));

describe("Sidebar Settings", () => {
  beforeEach(() => {
    mockPush.mockReset();
  });

  it("opens Lotus Settings in place instead of going to a settings page", () => {
    render(
      <LotusSettingsProvider sections={[settingsSectionStub("lotus", "editor")]}>
        <Sidebar />
      </LotusSettingsProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("editor body");
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
  });
});
