"use client";

import { useEffect, useState } from "react";

import { DRAFTS_CHANGED, draftThreadIds } from "../domain/composer-draft";

/** Which threads hold an unsent draft, kept current as drafts start and stop (this window or another). */
export function useDraftThreads(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const read = () => setIds(draftThreadIds());
    read();
    window.addEventListener(DRAFTS_CHANGED, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(DRAFTS_CHANGED, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return ids;
}
