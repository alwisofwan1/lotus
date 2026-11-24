"use client";
import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "./SettingsGroup";

// A SettingRow whose control is the global Switch.
interface SettingToggleRowProps {
  title: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

export function SettingToggleRow({ title, description, checked, onChange, disabled }: SettingToggleRowProps) {
  return (
    <SettingRow label={title} description={description}>
      <Switch checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </SettingRow>
  );
}
