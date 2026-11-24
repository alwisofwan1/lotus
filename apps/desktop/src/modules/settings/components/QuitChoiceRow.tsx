"use client";

import { useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri/runtime";
import { SettingSegmentedRow } from "@/modules/lotus-settings/components/SettingSegmentedRow";
import { getQuitChoice, setQuitChoice, type QuitChoice } from "@/modules/shell/services/quit-agents";

type Value = QuitChoice | "ask";

const OPTIONS: { value: Value; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "keep", label: "Keep running" },
  { value: "stop", label: "Stop all" },
];

/** The choice saved by the quit dialog's "Remember my choice"; "Ask" removes it. */
export function QuitChoiceRow() {
  const [value, setValue] = useState<Value>("ask");

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void getQuitChoice()
      .then((choice) => {
        if (!cancelled) setValue(choice ?? "ask");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SettingSegmentedRow
      title="When quitting with agents running"
      description={'Logout and shutdown use this too; with "Ask" they stop them'}
      options={OPTIONS}
      value={value}
      onChange={(next) => {
        setValue(next);
        if (isTauri()) void setQuitChoice(next === "ask" ? null : next).catch(() => {});
      }}
    />
  );
}
