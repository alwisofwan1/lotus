"use client";

import { useEffect, useState } from "react";
import { Bug } from "lucide-react";
import { loadBugReportContext } from "../services/bug-report";
import { BugReportDialog } from "./BugReportDialog";

/** The rail's bug icon. A red dot while a crash this machine had is still unreported. */
export function BugReportButton() {
  const [open, setOpen] = useState(false);
  const [crash, setCrash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadBugReportContext()
      .then((context) => !cancelled && setCrash(context.crash !== null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <button
        type="button"
        className="ws-chrome-button relative"
        aria-label={crash ? "Report a bug (Lotus hit an error)" : "Report a bug"}
        title="Report a bug"
        onClick={() => {
          setOpen(true);
          setCrash(false);
        }}
      >
        <Bug size={15} strokeWidth={1.75} />
        {crash ? (
          <span
            className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-(--ui-err) shadow-[0_0_0_2px_var(--bg)]"
            aria-hidden
          />
        ) : null}
      </button>
      <BugReportDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
