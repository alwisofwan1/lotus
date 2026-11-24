"use client";

import { useEffect, useState } from "react";
import { loadLaunchablePresets, type LaunchablePreset } from "@/modules/codespace/components/ConfigureLayoutView";
import { MiniGrid } from "@/modules/codespace/components/PresetPalette";
import type { Preset } from "@/modules/codespace/components/types";

/** How many saved presets the empty page offers; the rest live in the New workspace palette. */
const MAX_PRESETS = 3;

/** `/Users/me/work/app` → `~/work/app`; a remote preset keeps its host in front. */
export function shortPlace(p: Preset): string {
  const path = p.cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
  return p.location ? `${p.location.host}:${path}` : path;
}

interface CodeEmptyStateProps {
  onNewWorkspace: () => void;
  onLaunchPreset: (item: LaunchablePreset) => void;
}

/**
 * Code mode with no workspace (mockups/code-launch-shimmer-and-empty.html, B): one centred action,
 * plus "Jump back in" for saved presets. Styled with the New workspace tokens (`.cl-view`), so the
 * gold and the surfaces match the page this button opens.
 */
export function CodeEmptyState({ onNewWorkspace, onLaunchPreset }: CodeEmptyStateProps) {
  const [presets, setPresets] = useState<LaunchablePreset[]>([]);

  useEffect(() => {
    let live = true;
    loadLaunchablePresets()
      .then((items) => { if (live) setPresets(items.slice(0, MAX_PRESETS)); })
      .catch(() => undefined); // no presets is a fine empty page
    return () => { live = false; };
  }, []);

  return (
    <div className="ws-card cl-view cl-empty">
      <div className="cl-empty-body">
        <div className="cl-empty-glyph" aria-hidden="true"><i /><i /><i /><i /></div>
        <h2 className="cl-empty-title">Start a workspace</h2>
        <p className="cl-empty-lede">Pick a folder and the agents to run side by side.</p>
        <button type="button" className="cl-empty-cta" onClick={onNewWorkspace}>
          <span aria-hidden="true" className="cl-empty-cta-plus">+</span>
          New workspace
        </button>
        {presets.length > 0 ? (
          <div className="cl-empty-quick">
            <div className="cl-empty-label">Jump back in</div>
            {presets.map((item) => (
              <button
                key={item.preset.id}
                type="button"
                className="cl-empty-row"
                onClick={() => onLaunchPreset(item)}
                title={`Open ${item.preset.name}`}
              >
                <span className="cl-empty-tile"><MiniGrid tpl={item.template} /></span>
                <span className="cl-empty-row-text">
                  <span className="cl-empty-row-name">{item.preset.name}</span>
                  <span className="cl-empty-row-sub">{shortPlace(item.preset)}</span>
                </span>
                <span className="cl-empty-row-meta">
                  {item.template.sessions} {item.template.sessions === 1 ? "pane" : "panes"}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
