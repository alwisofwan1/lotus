"use client";

import { Globe2 } from "lucide-react";
import { isTauri } from "@/lib/tauri-api";
import { useBrowserPaneRuntime } from "@/modules/codespace/hooks/useBrowserPaneRuntime";

interface WorkbenchBrowserTabProps {
  url: string;
  webviewLabel: string;
  enabled?: boolean;
}

export function WorkbenchBrowserTab({ url, webviewLabel, enabled = true }: WorkbenchBrowserTabProps) {
  const { containerRef } = useBrowserPaneRuntime({
    label: webviewLabel,
    url,
    enabled,
    persistence: "keep-alive-hidden",
  });

  return (
    <div className="codespace-workbench-editor relative h-full">
      <div ref={containerRef} className="absolute inset-0" />
      {!url.trim() && (
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-md border border-blue-300/10 bg-blue-400/[0.06] text-blue-200/70">
              <Globe2 className="h-4 w-4" />
            </div>
            <p className="text-xs font-semibold text-[color:var(--codespace-panel-text)]">No URL Open</p>
            <p className="mt-1 max-w-[280px] text-[11px] leading-4 text-[color:var(--codespace-panel-text-muted)]">
              Select a browser pane or restore a saved URL tab to preview a page.
            </p>
          </div>
        </div>
      )}
      {url.trim() && !isTauri() && (
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-md border border-blue-300/10 bg-blue-400/[0.06] text-blue-200/70">
              <Globe2 className="h-4 w-4" />
            </div>
            <p className="text-xs font-semibold text-[color:var(--codespace-panel-text)]">URL Tab</p>
            <p className="mt-1 max-w-[280px] text-[11px] leading-4 text-[color:var(--codespace-panel-text-muted)]">
              URL tabs render as native webviews in the Tauri desktop app.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
