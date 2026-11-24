"use client";
import { useCallback, useMemo, useRef } from "react";
import { Check } from "lucide-react";
import { useCanvasTheme } from "@/modules/codecanvas/hooks/useCanvasTheme";
import { useResolvedThemeAsset } from "@/modules/codecanvas/hooks/useResolvedThemeAsset";
import { TEXT_SIZES, TEXT_SIZE_REM, type CanvasTheme, type TextSize } from "@/modules/codecanvas/types/canvas-theme";
import { SettingRow, SettingsGroup } from "@/modules/lotus-settings/components/SettingsGroup";

// Style tab — theme gallery (ADR-0023).
//
// A theme changes four things at once: the paper, the node material, the palette and the
// fonts. The card therefore shows a RENDERED STILL of the theme (see CanvasTheme.preview),
// not a swatch of `paper.fill` — on the photo themes `fill` is an admitted stand-in for the
// wallpaper, so a fill swatch previewed a look the theme does not have. Themes without a
// preview asset (any agent-authored one) fall back to a fill + palette card, so the gallery
// never has a hole in it.
//
// The name is live text in the theme's own display font rather than part of the bitmap:
// sharp at every card size, and renaming a theme cannot invalidate its asset.

function paletteDots(theme: CanvasTheme): string[] {
  const p = theme.palette;
  return [p.accent, p.agent, p.task, p.note, p.info];
}

function displayFont(theme: CanvasTheme): string {
  return `"${theme.fonts.display}", ui-rounded, system-ui, sans-serif`;
}

/** What a theme's paper is made of — the one word that distinguishes the groups. */
function sceneryLabel(theme: CanvasTheme): string | null {
  const kind = theme.paper.media?.kind;
  if (kind === "video") return "Motion";
  if (kind === "image") return "Photo";
  return null;
}

/**
 * The still for a theme, in the order that degrades cleanly:
 * `preview` → a video paper's poster → an image paper's src → nothing (CSS card).
 * Local refs (a user theme's own folder) resolve through the same reader the wallpaper uses.
 */
function useThemeStill(theme: CanvasTheme): string | undefined {
  const media = theme.paper.media;
  const ref = theme.preview ?? (media?.kind === "video" ? media.poster : media?.src);
  return useResolvedThemeAsset(theme.id, ref, "data");
}

interface CardProps {
  theme: CanvasTheme;
  selected: boolean;
  /** Roving tabindex: exactly one card in the whole gallery is tab-reachable. */
  tabbable: boolean;
  onSelect: () => void;
  onNav: (delta: number) => void;
}

function ThemeCard({ theme, selected, tabbable, onSelect, onNav }: CardProps) {
  const still = useThemeStill(theme);
  const scenery = sceneryLabel(theme);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${theme.name} — ${theme.descriptor}`}
      tabIndex={tabbable ? 0 : -1}
      data-selected={selected ? "true" : undefined}
      data-theme-id={theme.id}
      className="cc-theme-card"
      onClick={onSelect}
      onKeyDown={(e) => {
        // Arrow keys move within the gallery, matching the radiogroup pattern. Left/Up and
        // Right/Down both work: the grid reflows by width, so a "row" is not a fixed count.
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); onNav(1); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); onNav(-1); }
      }}
    >
      <span className="cc-theme-card-still" aria-hidden>
        {still ? (
          // eslint-disable-next-line @next/next/no-img-element -- static export, no image optimizer
          <img src={still} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className="cc-theme-card-fill" style={{ background: theme.paper.fill }}>
            <span className="cc-theme-card-fill-dots">
              {paletteDots(theme).map((color, i) => (
                <span key={i} style={{ background: color }} />
              ))}
            </span>
          </span>
        )}
      </span>
      <span className="cc-theme-card-plate">
        <span className="cc-theme-card-lines">
          <span className="cc-theme-card-name" style={{ fontFamily: displayFont(theme) }}>
            {theme.name}
          </span>
          <span className="cc-theme-card-desc">{theme.descriptor}</span>
        </span>
        {/* `color` as well as `background`: the CSS glow is a currentColor box-shadow. */}
        <span
          className="cc-theme-card-accent"
          style={{ background: theme.palette.accent, color: theme.palette.accent }}
          aria-hidden
        />
      </span>
      {scenery ? <span className="cc-theme-card-tag" aria-hidden>{scenery}</span> : null}
      {selected ? (
        <span className="cc-theme-card-check" aria-hidden>
          <Check size={11} strokeWidth={3} />
        </span>
      ) : null}
    </button>
  );
}

interface GroupProps {
  label: string;
  hint: string;
  themes: CanvasTheme[];
  themeId: string;
  tabbableId: string;
  onSelect: (id: string) => void;
  onNav: (id: string, delta: number) => void;
}

function ThemeGroup({ label, hint, themes, themeId, tabbableId, onSelect, onNav }: GroupProps) {
  if (!themes.length) return null;
  return (
    <div className="cc-theme-group">
      <p className="cc-theme-group-head">
        <span className="cc-theme-group-label">{label}</span>
        <span className="cc-theme-group-hint">{hint}</span>
      </p>
      <div className="cc-theme-grid">
        {themes.map((t) => (
          <ThemeCard
            key={t.id}
            theme={t}
            selected={themeId === t.id}
            tabbable={tabbableId === t.id}
            onSelect={() => onSelect(t.id)}
            onNav={(delta) => onNav(t.id, delta)}
          />
        ))}
      </div>
    </div>
  );
}

export function StyleTab() {
  const { themeId, theme, themes, setTheme, effectiveTextSize, setNodeTextSize } = useCanvasTheme();
  const galleryRef = useRef<HTMLDivElement>(null);

  // Three groups, in the order a person shops in: the scenes first (they are the reason
  // this tab is worth opening), then the flat surfaces, then anything the user authored.
  const groups = useMemo(() => {
    const sceneries: CanvasTheme[] = [];
    const surfaces: CanvasTheme[] = [];
    const mine: CanvasTheme[] = [];
    for (const t of themes) {
      if (t.origin === "user") mine.push(t);
      else if (t.paper.media) sceneries.push(t);
      else surfaces.push(t);
    }
    return { sceneries, surfaces, mine };
  }, [themes]);

  /** Gallery order — the sequence the arrow keys walk, matching the visual order. */
  const order = useMemo(
    () => [...groups.sceneries, ...groups.surfaces, ...groups.mine].map((t) => t.id),
    [groups],
  );
  // Roving tabindex: the selected card owns the tab stop, so Tab lands on the current
  // choice rather than walking every theme in the gallery.
  const tabbableId = order.includes(themeId) ? themeId : (order[0] ?? "");

  const onNav = useCallback(
    (fromId: string, delta: number) => {
      const i = order.indexOf(fromId);
      if (i < 0) return;
      const next = order[(i + delta + order.length) % order.length];
      setTheme(next);
      // Follow the selection with focus so the arrow keys keep working from the new card.
      galleryRef.current
        ?.querySelector<HTMLButtonElement>(`[data-theme-id="${next}"]`)
        ?.focus();
    },
    [order, setTheme],
  );

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title="Theme">
        <div className="cc-theme-gallery p-3.5" role="radiogroup" aria-label="Canvas theme" ref={galleryRef}>
          <ThemeGroup
            label="Sceneries"
            hint="photo or loop behind the graph"
            themes={groups.sceneries}
            themeId={themeId}
            tabbableId={tabbableId}
            onSelect={setTheme}
            onNav={onNav}
          />
          <ThemeGroup
            label="Surfaces"
            hint="lightest on the GPU"
            themes={groups.surfaces}
            themeId={themeId}
            tabbableId={tabbableId}
            onSelect={setTheme}
            onNav={onNav}
          />
          <ThemeGroup
            label="Yours"
            hint="written to ~/.lotus/canvas-themes"
            themes={groups.mine}
            themeId={themeId}
            tabbableId={tabbableId}
            onSelect={setTheme}
            onNav={onNav}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Nodes">
        <SettingRow
          label="Node text size"
          description="Font size for node content — the Markdown reader and chat. Doesn’t change the app’s menus or panels."
          body={
            // Renders at the size being chosen, in the theme's body face — so the control shows its
            // own effect instead of describing it.
            <p
              className="cc-textsize-sample"
              style={{
                fontSize: TEXT_SIZE_REM[effectiveTextSize as TextSize],
                fontFamily: `"${theme.fonts.body}", system-ui, sans-serif`,
              }}
            >
              The quick brown fox reads a node at this size.
            </p>
          }
        >
          <div role="group" aria-label="Node text size" className="ui-seg">
            {TEXT_SIZES.map((size, i) => (
              <button
                key={size}
                type="button"
                aria-pressed={effectiveTextSize === size}
                aria-label={`Set node text size ${size}`}
                onClick={() => setNodeTextSize(size)}
                className="ui-seg-btn w-8 justify-center px-0"
                style={{ fontSize: `${0.7 + i * 0.12}rem` }}
              >
                A
              </button>
            ))}
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
