import { useEffect, useState } from "react";
import { factoryChiefCheckedAt } from "@/lib/tauri/graph-run";

/** How often the strip asks when the Chief of Staff last looked; it looks once a minute. */
const ASK_EVERY_MS = 30_000;

/**
 * When the Chief of Staff last looked at the runs (Unix ms); null before its first look or while
 * the engine is not running. `read` is injectable for tests.
 */
export function useFactoryChiefCheckedAt(active: boolean, read: () => Promise<number | null> = factoryChiefCheckedAt): number | null {
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const ask = () =>
      read().then(
        (at) => alive && setCheckedAt(at),
        () => alive && setCheckedAt(null),
      );
    void ask();
    const id = setInterval(() => void ask(), ASK_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, read]);
  return checkedAt;
}
