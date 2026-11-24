"use client";
import type { ReactNode } from "react";
import { Select } from "@/components/ui/field";
import { SettingRow } from "./SettingsGroup";

// A SettingRow whose control is the global Select.
interface SettingSelectRowProps<T extends string> {
  title: string;
  description?: ReactNode;
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  /** Accessible label for the <select> (kept distinct from the visible title for a11y). */
  selectLabel: string;
  disabled?: boolean;
  /** Extra content below the row (e.g. an example preview), inside the same card. */
  footer?: ReactNode;
}

export function SettingSelectRow<T extends string>({ title, description, options, value, onChange, selectLabel, disabled, footer }: SettingSelectRowProps<T>) {
  return (
    <SettingRow label={title} description={description} body={footer ? <div className="ui-row-desc">{footer}</div> : undefined}>
      <Select label={selectLabel} options={options} value={value} onChange={onChange} disabled={disabled} />
    </SettingRow>
  );
}
