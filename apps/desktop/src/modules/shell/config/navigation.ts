import type { SvgIconComponent } from "@/shared/types/icons";
import { LayoutDashboard, LayoutTemplate } from "lucide-react";

export interface ShellNavItem {
  href: string;
  icon: SvgIconComponent;
  label: string;
  section: "main" | "workflows";
  badge?: number;
}

export const navItems: ShellNavItem[] = [
  { href: "/", icon: LayoutTemplate, label: "Workspace", section: "main" },
  { href: "/home", icon: LayoutDashboard, label: "Dashboard", section: "main" },
  { href: "/canvas", icon: LayoutTemplate, label: "CodeCanvas", section: "main" },
];
