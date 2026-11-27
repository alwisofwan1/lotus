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
  `live` ≥ 3.0 (a dot); `onWaiting` on `waiting` and `onError` on `error` ≥ 4.5.
- **Order**: text > text2 > text3 > ornament by contrast.
- **Amber is the only meaningful hue** (OKLCH): `waiting` hue 50–95°, chroma ≥ 0.10;
  every neutral role chroma ≤ 0.03 and ≥ 0.10 ΔE_ok from `waiting`; `live` and `error` at
  least 60° of hue away from it.
- **Terminal**: foreground ≥ 4.5 and cursor ≥ 3.0 on the terminal background; every ANSI
  colour ≥ 3.0 on it (black too: SGR 30 is text); `white` ≥ 4.5 on `black` (inverse video).
- **Camera**: the scanner keeps its own dark ground in every theme (`camera`), and its text
  roles `onCamera`, `onCamera2`, `onCamera3` must clear 4.5 on it.
- **Brand marks** ≥ 3.0 on `ground` and `raised`, using the table for the variant's
  brightness (`tokens/brand_marks.dart`; on light, Cursor and Grok go dark and the rest deepen).
- Built theme: no `ColorScheme` role equals `waiting`; text buttons keep the 44 px target.

**Waivers.** A variant may list subjects it knowingly fails in `ThemeVariant.waivers`, each
with a reason. A test fails if a waiver no longer matches a real violation. Classic waives
three, to keep its look: `ansi black` (1.05:1, black is a ground by convention),
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

## Classic

The only theme today, dark-only (the light slot carries the dark variant).

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
