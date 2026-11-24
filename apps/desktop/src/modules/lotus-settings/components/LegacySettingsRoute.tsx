"use client";
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { loadLastActiveShellDestination } from "@/modules/shell/services/last-shell-destination";
import { useLotusSettings } from "../lotus-settings-context";

/**
 * What is left of the old Settings page: a `/settings?section=` link still works. It opens Lotus
 * Settings on that section (retired ids map to their new homes, see `open-request.ts`) and puts the
 * window back on the mode the user came from — the modal lives in the shell, so it stays open.
 */
export function LegacySettingsRoute() {
  const router = useRouter();
  const section = useSearchParams().get("section") ?? undefined;
  const { openSettings } = useLotusSettings();

  useEffect(() => {
    openSettings(section ? { section } : {});
    router.replace(loadLastActiveShellDestination());
  }, [openSettings, router, section]);

  return null;
}
