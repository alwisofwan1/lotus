"use client";
import { BrandMark } from "@/components/icons/BrandMark";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  SquarePlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { openNewWindow } from "@/lib/tauri-api";
import { useMacOverlayChrome } from "@/lib/hooks/useMacOverlayChrome";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";
import { navItems } from "@/modules/shell/config/navigation";
import { useSidebar } from "@/modules/shell/containers/AppShell";
import { useLotusSettings } from "@/modules/lotus-settings/lotus-settings-context";

const mainItems = navItems.filter((item) => item.section === "main");
const workflowItems = navItems.filter((item) => item.section === "workflows");

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, toggle } = useSidebar();
  const { openSettings } = useLotusSettings();
  const isMacOverlayChrome = useMacOverlayChrome();
  const shortcut = useFormatShortcut();
  const handleNewWindow = () => {
    void openNewWindow(pathname);
  };

  const NavItem = ({ item }: { item: (typeof navItems)[number] }) => {
    const Icon = item.icon;
    const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));

    return (
      <Link
        href={item.href}
        title={collapsed ? item.label : undefined}
        className={cn(
          "flex items-center rounded-xl transition-all duration-150 group",
          collapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2 text-sm",
          // Active is a fill and an inset hairline in primary text, never the accent (mockup 10, T2).
          active
            ? "bg-(--ds-workbench-surface-active) text-(--fg) shadow-(--ds-shadow-edge)"
            : "text-(--text-secondary) hover:text-(--fg) hover:bg-(--bg-hover)",
        )}
      >
        <Icon
          className={cn(
            "shrink-0 transition-all duration-150",
            collapsed ? "w-[18px] h-[18px]" : "w-4 h-4",
            active ? "text-(--fg)" : "text-(--text-muted) group-hover:text-(--text-secondary)",
          )}
        />
        <span
          className={cn(
            "flex-1 whitespace-nowrap overflow-hidden transition-[opacity,max-width] ease-in-out",
            collapsed ? "max-w-0 opacity-0 duration-100" : "max-w-[200px] opacity-100 duration-200",
          )}
        >
          {item.label}
        </span>
        {!collapsed &&
          (item.badge ? (
            <span className="bg-[var(--accent)] text-[var(--accent-fg)] text-xs w-5 h-5 rounded-full flex items-center justify-center font-medium shrink-0">
              {item.badge}
            </span>
          ) : active ? (
            <ChevronRight className="w-3 h-3 text-(--text-muted) shrink-0" />
          ) : null)}
      </Link>
    );
  };

  return (
    <aside
      className={cn(
        "glass-sidebar flex flex-col h-screen border-r border-(--ds-hairline) shrink-0",
        "transition-[width,padding] duration-200 ease-in-out",
        isMacOverlayChrome ? "pb-4 pt-11" : "py-4",
        collapsed ? "w-14 px-1.5" : "w-60 px-3",
      )}
    >
      <div className={cn("flex items-center mb-6", collapsed ? "flex-col gap-2" : "gap-2.5 px-1")}>
        <BrandMark className="w-8 h-8 shrink-0" />
        <div
          className={cn(
            "flex-1 min-w-0 transition-[opacity,max-width] ease-in-out overflow-hidden",
            collapsed ? "max-w-0 opacity-0 duration-100" : "max-w-[160px] opacity-100 duration-200",
          )}
        >
          <h1 className="text-sm font-bold text-(--fg) whitespace-nowrap">Lotus</h1>
        </div>
        <button
          onClick={toggle}
          title={`${collapsed ? "Expand" : "Collapse"} sidebar (${shortcut("⌘B")})`}
          className="flex items-center justify-center rounded-lg text-(--text-muted) hover:text-(--fg) hover:bg-(--bg-hover) transition-all duration-150 shrink-0 w-7 h-7"
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
      </div>

      {collapsed ? (
        <div className="flex flex-col items-center gap-2 mb-5">
          <button
            type="button"
            onClick={handleNewWindow}
            title="New Window"
            aria-label="New Window"
            className="flex items-center justify-center w-9 h-9 rounded-xl border border-(--border) bg-(--bg-hover) text-(--fg) hover:bg-(--bg-tertiary) transition-colors"
          >
            <SquarePlus className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 mx-1 mb-5">
          <button
            type="button"
            onClick={handleNewWindow}
            className="flex items-center justify-center gap-2 py-2 rounded-xl border border-(--border) bg-(--bg-hover) hover:bg-(--bg-tertiary) text-(--fg) text-sm font-medium transition-colors"
          >
            <SquarePlus className="w-4 h-4" /> New Window
          </button>
        </div>
      )}

      <nav className="flex flex-col gap-0.5 mb-4">
        {mainItems.map((item) => (
          <NavItem key={item.href} item={item} />
        ))}
      </nav>

      {workflowItems.length > 0 && (
        <div className="mb-2">
          {collapsed ? (
            <div className="border-t border-(--border) mx-1 mb-2" />
          ) : (
            <p className="text-xs font-semibold text-(--text-muted) uppercase tracking-wider mb-2 px-3">Workflows</p>
          )}
          <div className="flex flex-col gap-0.5">
            {workflowItems.map((item) => (
              <NavItem key={item.href} item={item} />
            ))}
          </div>
        </div>
      )}

      <div className="flex-1" />

      <div className="flex flex-col gap-0.5 pt-3 border-t border-(--border-sub)">
        {/* Lotus Settings is a modal over the current mode (ADR-0054), not a route. */}
        <button
          type="button"
          onClick={() => openSettings()}
          aria-label="Settings"
          title={collapsed ? "Settings" : undefined}
          className={cn(
            "flex items-center rounded-xl transition-all duration-150 group text-(--text-secondary) hover:text-(--fg) hover:bg-(--bg-hover)",
            collapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2 text-sm",
          )}
        >
          <Settings
            className={cn(
              "shrink-0 transition-all duration-150 text-(--text-muted) group-hover:text-(--text-secondary)",
              collapsed ? "w-[18px] h-[18px]" : "w-4 h-4",
            )}
          />
          {!collapsed && <span className="flex-1 whitespace-nowrap text-left">Settings</span>}
        </button>
      </div>

      {collapsed ? (
        <div className="mt-3 flex justify-center" title="1 team active · 3 agents running">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        </div>
      ) : (
        <div className="mt-3 mx-1 p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/15">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-emerald-400 font-medium">1 team active</span>
          </div>
          <p className="text-xs text-(--text-muted)">3 agents running</p>
        </div>
      )}
    </aside>
  );
}
