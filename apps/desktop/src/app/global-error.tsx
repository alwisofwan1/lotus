"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { buildThemeBootstrapScript } from "@/lib/design-system";
import { BugReportDialog } from "@/modules/bug-report/components/BugReportDialog";
// This page replaces the root layout, so it loads the tokens itself.
import "./globals.css";
import "../styles/design-system.css";
import "../styles/ui-kit.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [reporting, setReporting] = useState(false);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="m-0 grid min-h-screen place-items-center bg-(--ds-canvas) text-(--ui-ink) antialiased">
        <script id="theme-bootstrap" dangerouslySetInnerHTML={{ __html: buildThemeBootstrapScript() }} />
        <div className="ui-dialog-in max-w-[360px] px-6 text-center">
          <p className="text-[15px] font-semibold tracking-[-0.01em]">Lotus could not render this view</p>
          <p className="mt-1 text-[13px] text-(--ui-ink-3)">
            Reload it to carry on, or tell us what happened.
            {error.digest ? <span className="mt-1 block font-mono text-[11.5px] text-(--ui-ink-4)">{error.digest}</span> : null}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="ghost" onClick={() => setReporting(true)}>Report this</Button>
            <Button variant="primary" onClick={reset}>Reload this view</Button>
          </div>
        </div>
        <BugReportDialog
          open={reporting}
          onClose={() => setReporting(false)}
          viewError={{ message: `${error.name}: ${error.message}`, digest: error.digest }}
        />
      </body>
    </html>
  );
}
