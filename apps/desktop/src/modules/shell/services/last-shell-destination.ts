import { navItems } from "@/modules/shell/config/navigation";

/**
 * The mode the window was last in, so a route that only passes through — the old
 * `/settings?section=` link, which opens Lotus Settings and steps aside — can send the window back.
 * `/settings` itself is never recorded: it is not a place anyone stays.
 */

// The key keeps its value: renaming it would forget every window's last mode.
export const LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY = "shell:last-active-destination";
export const DEFAULT_SHELL_DESTINATION = "/";

function matchesShellItem(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/" && pathname.startsWith(href));
}

export function resolveShellDestinationFromPath(pathname: string): string {
  const matchingItem = navItems.find((item) => matchesShellItem(pathname, item.href));
  return matchingItem?.href ?? DEFAULT_SHELL_DESTINATION;
}

export function persistLastActiveShellDestination(pathname: string): void {
  if (typeof window === "undefined" || pathname.startsWith("/settings")) return;

  const destination = resolveShellDestinationFromPath(pathname);
  window.localStorage.setItem(LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY, destination);
}

export function loadLastActiveShellDestination(): string {
  if (typeof window === "undefined") return DEFAULT_SHELL_DESTINATION;

  const rawValue = window.localStorage.getItem(LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY);
  if (!rawValue) return DEFAULT_SHELL_DESTINATION;

  const isAllowedDestination = navItems.some((item) => item.href === rawValue);
  return isAllowedDestination ? rawValue : DEFAULT_SHELL_DESTINATION;
}
