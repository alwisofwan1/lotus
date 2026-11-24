import 'package:flutter/material.dart';

import 'app_tokens.dart';

/// The one place `ThemeData` is built for this app.
///
/// No screen should call `ThemeData(...)` directly — that would leave [AppTokens]
/// out of the resulting theme, and `context.tokens` would fail exactly where a
/// widget reaches for it. This function is what keeps that a compiler-adjacent rule
/// rather than a hoped-for one: there is only one call site to get right.
///
/// Parameterised by [tokens] and [brightness] independently, which is the whole
/// mechanism this buys for scaling later: a second theme variant — a light mode, a
/// high-contrast mode, a per-test palette — is a second [AppTokens] constant handed
/// to this same function, never a second theme-building function to keep in sync
/// with this one. Today there is exactly one caller and it passes nothing, because
/// the locked mockup (`design/pocket-flow.html`) ships dark-only.
ThemeData buildAppTheme({
  AppTokens tokens = AppTokens.dark,
  Brightness brightness = Brightness.dark,
}) {
  final materialDefaults = brightness == Brightness.dark
      ? const ColorScheme.dark()
      : const ColorScheme.light();

  // Only the roles with a real Pocket equivalent are overridden. Deliberately absent:
  // `secondary` and `tertiary` — if a stray default-styled Material widget (a `Chip`,
  // a `TabBar` indicator) ever reaches for one of those, it should get an inert
  // Material default, never `tokens.waiting`. Amber means one thing (MVP.md), and
  // that must stay a deliberate `context.tokens.waiting` at the call site, not
  // something a generic widget can pick up by accident.
  final colorScheme = materialDefaults.copyWith(
    surface: tokens.bg,
    onSurface: tokens.text,
    // The dispatch/send button's own treatment is `background: text, foreground:
    // bg` — an inversion, not an accent colour — so `primary` follows that rather
    // than borrowing `waiting`.
    primary: tokens.text,
    onPrimary: tokens.bg,
    outline: tokens.line,
    outlineVariant: tokens.lineStrong,
    // Material's `error` role and Pocket's share the same meaning (a cell that
    // failed), unlike `primary`/`secondary`, which is why this one is aligned.
    error: tokens.error,
    // Not evidenced by the mockup — no error-filled component exists there to
    // measure. `bg` gives good contrast against the mid-tone `error` red, but revisit
    // this the day an actual filled error component is designed.
    onError: tokens.bg,
    // **The two roles a third-party builder reaches for without asking.** The rule
    // above — leave a role at its Material default so nothing can borrow `waiting` by
    // accident — protects the roles that *mean* something here. These two mean nothing
    // here and are still drawn on this screen: `gpt_markdown` fills its table header
    // with `surfaceContainerHighest` and its source-tag chip with `onInverseSurface`,
    // neither of which this app ever named. Measured 2026-09-16 by rendering
    // `AgentProse` in a widget test and reading the colours back: the table came out
    // fenced in `#F7F2EA` lines with a lifted header, on a screen whose whole argument
    // is that it has no cards and no fences.
    //
    // Pointing them at this app's own surfaces costs nothing and closes the door: a
    // package that reaches for a container surface now gets `raise`, which is the only
    // step off the floor this design has.
    surfaceContainerHighest: Color.alphaBlend(tokens.raise, tokens.bg),
    surfaceContainerHigh: Color.alphaBlend(tokens.raise, tokens.bg),
    onInverseSurface: Color.alphaBlend(tokens.raise, tokens.bg),
  );

  final base = ThemeData(
    brightness: brightness,
    colorScheme: colorScheme,
    scaffoldBackgroundColor: tokens.bg,
    extensions: [tokens],
  );

  // Applied explicitly rather than left to ThemeData's own default text/colour
  // inference: that default is real but undocumented as a contract, and an
  // incidental Material text widget silently drifting off `tokens.text` on some
  // future Flutter upgrade is exactly the kind of glitch this function exists to
  // prevent.
  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: tokens.text, displayColor: tokens.text),
    // Every `TextButton` in this app is a bare caps label — `TRY AGAIN`, `DIAGNOSTICS`,
    // `RAW TERMINAL`, `BACK` — drawn small on purpose. Material's own default is 36px
    // tall, under the 44 the rest of the app holds itself to, and a label styled down
    // to 11px shrinks the visible target further. Setting it here rather than at four
    // call sites means the next bare label added is born the right size.
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        minimumSize: const Size(kMinHitTarget, kMinHitTarget),
        tapTargetSize: MaterialTapTargetSize.padded,
      ),
    ),
  );
}
