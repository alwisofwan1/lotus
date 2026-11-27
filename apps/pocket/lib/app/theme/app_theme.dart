import 'package:flutter/material.dart';

import 'app_tokens.dart';
import 'palettes/classic.dart';
import 'theme_variant.dart';

/// The one place `ThemeData` is built; a new theme is a new [ThemeVariant], never a builder.
/// Defaults to classic dark. Material mapping rules: `docs/theme.md#material-mapping`.
ThemeData buildAppTheme([ThemeVariant? variant]) {
  final v = variant ?? classic.dark;
  final t = v.tokens;
  final materialDefaults =
      v.brightness == Brightness.dark ? const ColorScheme.dark() : const ColorScheme.light();
  final container = Color.alphaBlend(t.raise, t.bg);

  // secondary/tertiary stay at inert defaults, so no generic widget can pick up `waiting`.
  final colorScheme = materialDefaults.copyWith(
    surface: t.bg,
    onSurface: t.text,
    // The send button is an inversion (text on bg), not an accent.
    primary: t.text,
    onPrimary: t.bg,
    outline: t.line,
    outlineVariant: t.lineStrong,
    error: t.error,
    onError: t.onError,
    // Third-party packages (gpt_markdown tables, chips) reach for these unasked.
    surfaceContainerHighest: container,
    surfaceContainerHigh: container,
    onInverseSurface: container,
  );

  final base = ThemeData(
    brightness: v.brightness,
    colorScheme: colorScheme,
    scaffoldBackgroundColor: t.bg,
    extensions: v.extensions,
  );

  // Explicit, so Material text never drifts off `text` on a Flutter upgrade.
  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: t.text, displayColor: t.text),
    // Bare caps labels would otherwise be 36px tall, under the 44 hit target.
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        minimumSize: const Size(kMinHitTarget, kMinHitTarget),
        tapTargetSize: MaterialTapTargetSize.padded,
      ),
    ),
  );
}
