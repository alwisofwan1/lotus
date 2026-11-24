"use client";
import { Suspense } from "react";
import { LegacySettingsRoute } from "@/modules/lotus-settings/components/LegacySettingsRoute";

// The old Settings page is gone (ADR-0054); its URL opens Lotus Settings instead.
export default function SettingsRoute() {
  return (
    <Suspense fallback={null}>
      <LegacySettingsRoute />
    </Suspense>
  );
}
