"use client";

import type { ReactNode } from "react";
import { FactoryRunCard, useFactoryRun, type UseFactoryRunInput } from "@/modules/factory";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";

/**
 * A GitHub issue's Factory Run (ADR-0049, F2b), read live, as the Factory's small card. A component
 * so the panel can show it or not without a conditional hook. Every action past starting the run
 * lives in the Factory, which `onOpenInFactory` opens on this run.
 */
export function FactoryRun({
  presets,
  onOpenInFactory,
  onOpenInChief,
  picker,
  ...input
}: UseFactoryRunInput & { presets: readonly DelegationPreset[]; onOpenInFactory?: () => void; onOpenInChief?: () => void; picker?: ReactNode }) {
  return (
    <>
      <h3 className="tk-props-h">Factory</h3>
      {picker}
      <FactoryRunCard run={useFactoryRun(input)} presets={presets} onOpenInFactory={onOpenInFactory} onOpenInChief={onOpenInChief} />
    </>
  );
}
