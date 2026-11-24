"use client";

import { Moon, Settings, Sun } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { themeRevealOrigin } from "@/lib/design-system/theme-transition";
import { BugReportButton } from "@/modules/bug-report/components/BugReportButton";
import { UsageChip } from "./UsageChip";

// Modes are rows of the Jump palette now; its key is the one hint worth the space.
const MODE_KEYS = [["⌘J", "Jump"]] as const;

/**
 * The rail's last line, shared by the Code and Chat rails.
 *
 * The theme button flips to the opposite of what is on screen, so it reads the resolved mode
 * rather than the preference: under System the first click pins whichever mode is not showing.
 * Both glyphs are rendered and CSS picks one by `data-theme-type`, because the server renders
 * Dark and the client may not be — the same hydration trap the brand images fell into.
 */
export function RailFooter({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { resolvedThemeMode, setThemePreference } = useTheme();

  return (
    <>
    <UsageChip />
    <div className="ws-rail-footer">
      <span className="ws-rail-hints">
        {MODE_KEYS.map(([key, label]) => (
          <span key={key} className="ws-rail-hint">
            <kbd>{key}</kbd>
            {label}
          </span>
        ))}
      </span>
      <span className="ws-rail-footer-actions">
        <BugReportButton />
        <button type="button" className="ws-chrome-button" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
          <Settings size={15} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="ws-chrome-button ws-theme-toggle"
          aria-label="Toggle theme"
          title="Theme"
          onClick={(event) =>
            setThemePreference(
              resolvedThemeMode === "dark" ? "light" : "dark",
              themeRevealOrigin(event.currentTarget, event),
            )
          }
        >
          <Sun size={15} strokeWidth={1.75} data-theme-glyph="dark" />
          <Moon size={15} strokeWidth={1.75} data-theme-glyph="light" />
        </button>
      </span>
    </div>
    </>
  );
}
