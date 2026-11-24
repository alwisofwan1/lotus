"use client";
import type { ReactNode } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow } from "./SettingsGroup";

// A SettingRow whose control is the global SegmentedControl (2–3 mutually exclusive options).
interface SettingSegmentedRowProps<T extends string> {
  title: string;
  description?: ReactNode;
  /** Options in display order. */
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  /** Extra content below the row (e.g. a conditional fineprint), inside the same card. */
  footer?: ReactNode;
}

export function SettingSegmentedRow<T extends string>({ title, description, options, value, onChange, disabled, footer }: SettingSegmentedRowProps<T>) {
  return (
    <SettingRow label={title} description={description} body={footer ? <div className="ui-row-desc">{footer}</div> : undefined}>
      <SegmentedControl label={title} options={options} value={value} onChange={onChange} disabled={disabled} />
    </SettingRow>
  );
}
