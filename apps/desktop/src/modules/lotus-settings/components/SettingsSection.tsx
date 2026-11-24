"use client";
import type { ReactNode } from "react";
import { Tag } from "@/components/ui/status";
import { SettingsGroup } from "./SettingsGroup";

// Older name for SettingsGroup, kept so call sites read the same: a caption (with an optional badge
// and one-line description) over one card of rows.
interface SettingsSectionProps {
  label: string;
  badge?: string;
  description?: ReactNode;
  children: ReactNode;
}

export function SettingsSection({ label, badge, description, children }: SettingsSectionProps) {
  return (
    <SettingsGroup title={label} action={badge ? <Tag accent>{badge}</Tag> : undefined} description={description}>
      {children}
    </SettingsGroup>
  );
}
