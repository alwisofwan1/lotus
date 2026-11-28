# Pocket theme

Everything visual a widget reads comes from `lib/app/theme/`. Features import exactly one
file from there, `app/theme/theme.dart`; `test/architecture/layering_test.dart` enforces it
(relative imports included) and forbids `Color(0x…)` / `Colors.*` under `lib/features/`.

## Tiers

| Tier | Where | What |
|---|---|---|
| Primitive | `palettes/<id>.dart` (private) | raw hexes of one theme |
| Semantic | `tokens/` | `ColorRole`, `TypeRole`, `ShapeRole`, `ElevationRole`, `TermRole`, `AppMotion`, brand marks |
| Component | `components/` | `SheetTokens` …: pure functions of the semantic tier, never authored per theme |

Every role table is stored **by enum index** (`tokens/role_table.dart`), so `==`, `hashCode`
and `lerp` cannot skip a role; a palette that leaves a role out throws at startup.
`test/app/theme/role_completeness_test.dart` walks every enum value, so a new role is
covered without a test edit.

`AppTokens` (`context.tokens`) is a facade over `AppColors` + `AppType` that keeps the
getter names widgets already use: `bg`=ground, `raise`=raised, `raise2`=track,
`termBg`=termGround, `keyHi`=keyActive, `dim`=text2, `muted`=text3, `faint`=ornament,
`line`=hairline, `lineStrong`=hairlineStrong. Its font table is called `fonts`, not `type`:
`ThemeExtension.type` is the key `ThemeData` stores extensions under, and a field of that
name silently unregisters the extension.

`ThemeData.extensions` holds `AppTokens`, `TerminalPalette`, `AppShape`, `AppElevation`.
Motion is not theme-dependent, so it is plain constants.

## Adding a theme

1. Copy `lib/app/theme/palettes/classic.dart` to `palettes/<id>.dart`; fill every role for
   a light and a dark `ThemeVariant` (a theme with one brightness passes it twice).
2. Add it to `themeRegistry` in `lib/app/theme/registry.dart`.
3. `flutter test test/app/theme` — the invariant suite runs over the new variants and names
   each broken rule with the measured value.

No widget, builder or test changes. `ThemeController.select('<id>')` shows it.

## Invariants (`invariants/rules.dart`)

- **Pairing matrix** (WCAG 2.1, translucent roles composited over `ground` the way
  `Color.alphaBlend` does): `text`, `text2`, `waiting` ≥ 4.5 on every surface; `text3` ≥ 4.5
  on `ground` and `raised` (sheets); `ornament` ≥ 3.0 (non-text only); `error` ≥ 4.5 on ground/raised/track;
  `live` ≥ 3.0 (a dot); `onWaiting` on `waiting` and `onError` on `error` ≥ 4.5;
  `waitingRule` ≥ 3.0 on every surface (borders and dots, non-text). A needs-you card head is
  `waitingTint` over `raised`: `waiting` ≥ 4.5 and `waitingRule` ≥ 3.0 on that blend too.
- **Order**: text > text2 > text3 > ornament by contrast.
- **Amber is the only meaningful hue** (OKLCH): `waiting` hue 50–95°, chroma ≥ 0.10
  (`waitingRule` and `waitingTint` hue in the same band);
  every neutral role chroma ≤ 0.03 and ≥ 0.10 ΔE_ok from `waiting`; `live` and `error` at
  least 60° of hue away from it.
- **Terminal**: foreground ≥ 4.5 and cursor ≥ 3.0 on `termGround`; every ANSI colour ≥ 3.0
  on it (black too: SGR 30 is text); `white` ≥ 4.5 on `black` (inverse video). The xterm
  view draws with `backgroundOpacity: 0` over a `termGround` box, so `TermRole.background`
  is never painted and is not the ground measured.
- **Terminal chrome**: what is drawn on `termGround` (page header, keys, status bar) uses
  `ThemeVariant.onTerminal` — the `terminalChrome` variant if set, else the variant itself.
  Its `termGround` must equal this one's, its text / text2 / text3 ≥ 4.5 and ornament ≥ 3.0
  on it. `buildAppTheme` exposes it as the `TerminalChrome` extension; the agent page wraps
  its chrome in `context.terminalChrome` and sets the bars with `overlayFor(ground)`.
- **Camera**: the scanner keeps its own dark ground in every theme (`camera`), and its text
  roles `onCamera`, `onCamera2`, `onCamera3` must clear 4.5 on it.
- **Brand marks** ≥ 3.0 on `ground` and `raised`, using the table for the variant's
  brightness (`tokens/brand_marks.dart`; on light, Cursor and Grok go dark and the rest deepen).
- Built theme: no `ColorScheme` role equals `waiting`; text buttons keep the 44 px target.

**Waivers.** A variant may list subjects it knowingly fails in `ThemeVariant.waivers`, each
with a reason. A test fails if a waiver no longer matches a real violation. Classic waives
five, to keep its look: `ansi black on termGround` (black is a ground by convention),
`ansi brightBlack on termGround` and `chrome ornament on termGround` (2.96:1, ornament ink),
`text3 on raised` (4.42:1 on sheets) and `onCamera3 on camera` (4.43:1, the scan hint).

The matrix states what the app guarantees today. A palette that sits text3 on a raised
surface tightens it there.

## Material mapping

`buildAppTheme` (`app_theme.dart`) is the only `ThemeData` builder.

- `primary` = text, `onPrimary` = bg: the send button is an inversion, not an accent.
- `secondary` / `tertiary` stay at Material defaults, so no stock widget can borrow amber.
  Amber means one thing — an agent needs you — and reaching it is always a deliberate
  `context.tokens.waiting`.
- `error` is aligned: Material's and Pocket's meaning match.
- `surfaceContainerHighest`, `surfaceContainerHigh`, `onInverseSurface` point at the raised
  surface: `gpt_markdown` fills table headers and chips from them without asking, and left
  at defaults they drew light fences on a screen that has none.
- Text colours are applied explicitly so a Flutter upgrade cannot drift them.
- `TextButton` minimum size is `kMinHitTarget` (44): every bare caps label is born tappable.
- `bottomSheetTheme` carries the sheet fill and shape (`SheetTokens`). A route reads its
  theme on every build, so an open sheet repaints when the theme changes. Pass neither as
  an argument, and read tokens from the route's `context`, never the opener's: both are
  captured once when the route opens. The barrier colour is still captured on open.

## Shape

`ShapeRole` names radii by job (`card`, `chip`, `bubble`, `sheetLarge` …), read as
`context.shape.radius(ShapeRole.x)`. Classic carries each job's historic radius, so it looks
as it did; Graphite folds them onto 10 / 16 / 24 / pill. Marks of 3 px or less and radii
computed from a size stay geometry. `test/architecture/radius_tokens_test.dart` refuses a
literal radius above 3 px under `lib/features/`.

## Choosing a theme

`defaultThemeId` (`registry.dart`) is Graphite, mode `ThemeMode.system`. The pick is saved
by `data/theme_choice.dart` (`theme:id`, `theme:appearance`) and restored before the first
frame by `ThemeController.restore`; an id no longer registered falls back to the default.
Settings shows the picker (`features/settings/widgets/appearance_block.dart`), fed by
`appearanceOf` in `app/diagnostics_route.dart`.

## Graphite

The default. Graphite & Paper: opaque warm neutrals, one real light and one real dark
variant, **no waivers**. No `BackdropFilter`: floating surfaces are fill + hairline + shadow.

**Type.** Geist (400 / 500 / 600) for UI and prose, Geist Mono (400) for `mono`, bundled
from vercel/geist-font 1.9.2 (`assets/fonts/`, OFL). The terminal keeps its own font stack
(`terminal_metrics.dart`): its grid metrics are fragile.

**Re-solved for AA** (hue kept, lightness moved; ratios against the worst surface in the rule):

| role | mockup | shipped | contrast |
|---|---|---|---|
| dark text3 | `#7C786F` 3.96 | `#868279` | 4.55 on s1 |
| light text3 | `#85807A` 3.53 | `#736E69` | 4.55 on ground |
| light waiting | `#B45309` 3.81 | `#9B4F04` | 4.52 worst; hue 49° → 55° to enter the amber band |
| light waitingRule | `#D97706` 2.42 | `#C26904` | 3.01 worst (non-text) |
| dark waiting | `#F0B347` | `#F5B451` | 7.69 worst |
| dark error | `#F2837A` | `#E7768A` | hue 10°, 65° from amber |
| light error | `#C2362B` | `#BD3379` | hue 354°, 61° from amber |

**Amber has three jobs since 2026-11-28** (apps/pocket/DESIGN.md §2): `waiting` is text and
icons, `waitingRule` is borders and dots, `waitingTint` (8% light, 10% dark) is the fill behind a
needs-you card head. Classic maps all three to its one desktop amber.

The mockup's reds sat 53° and 34° from amber; the status-hue rule wants 60°, and amber's hue
is the one that keeps its meaning, so red moved.

**Roles the mockup left open.** `key` = s2, `keyActive` = s3 (pressed). Ornament `#65625B`
dark / `#908B83` light (≥ 3.0). The terminal ground stays dark in light mode: dark's `#0B0B0A`
(the mockup's `#111110` would split header from pane). Both variants share one terminal
palette built from the dark roles, and light's `terminalChrome` is the dark variant, so the
terminal page's header, keys and bar icons use dark-theme ink. ANSI black is a
readable grey `#66635C` (3.29 on the ground, white 4.99 on it) and bright black is text3.
The camera is black with the dark text roles in both. Brand marks pass on both tables.

## Classic

Dark-only (the light slot carries the dark variant).

**Floor.** `ground` is `oklch(0.183 0.004 286°)`, `#121214`. The earlier floor sat at
`oklch(0.132 …)`, where an OLED plus ambient reflection crushes gradation, so the raised
step (+0.052 ΔL) rendered as nothing. At 0.183 raised is +0.043, hairline +0.081, and the
terminal well (`oklch(0.130)`) still 0.055 below, so it reads as a hole. Lightness was
checked on a phone. The floor is cool-neutral on purpose: it puts amber 158° away from its
ground, where a warm floor put it 6°, and on a screen whose job is finding one amber word,
hue belongs to the signal.

**Quiet text.** Three levels, solved against `ground` rather than copied from a mockup
alpha (a mockup is rendered on a desktop display; this screen is read outdoors):

| role | alpha | contrast | use |
|---|---|---|---|
| text2 (`dim`) | 0xA0 | 7.06:1 | interactive labels |
| text3 (`muted`) | 0x79 | 4.52:1 | the floor for anything that is text |
| ornament (`faint`) | 0x5A | 3.04:1 | pips, marks, disabled glyphs — never a sentence |

The mockup's own alphas gave 7.07 / **3.47** / **1.80** on the old floor, and ornament was
carrying sole affordances (`RAW TERMINAL`, `TRY AGAIN`, the back caret). Raising it to pass
as text would have collapsed three levels into two, so it was reassigned to non-text, which
needs WCAG 1.4.11's 3:1. When the floor moved, text2 and text3 went *down*: a brighter
substrate needs less ink. Ratios use `Color.alphaBlend`'s float arithmetic — an 8-bit
calculation put text2 at 7.02 where Flutter renders 6.985, a fail.

**Status.** `waiting` `#FBBF24` and `error` `#F87171` keep desktop's
`--canvas-status-connecting` / `--canvas-status-error` hexes; amber stays above 10:1.
Desktop's floor is still `#07070d`, so the two apps no longer share one — bringing it
across is a separate decision. `live` `#3FBF8F` is the Home row's working dot: `waiting`
is *you*, `live` is *it*. `onWaiting` `#17130A` is dark ink on the amber banner; `ground`
was too dark to read at that weight.

**Surfaces.** `track` `#232325` holds controls (the Chat | Terminal switch); `termGround`
`#0A0A0B` is darker than `ground` so entering the terminal reads as entering a pane; `key`
/ `keyActive` are a key cap and a held or chosen one.

**Terminal.** ANSI yellow and red reuse `waiting` and `error`, so an agent's warning is not
a third amber. The selection is sky at 0.42 alpha: it was the raised grey once and could
not be found on a phone in daylight. Find-bar hits are two weights of the app's own ink —
a hit is neither "needs you" nor "failed".
