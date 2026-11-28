import 'package:flutter/material.dart';

import 'app_tokens.dart';
import 'components/components.dart';
import 'palettes/classic.dart';
import 'tokens/terminal_chrome.dart';
import 'theme_variant.dart';

/// The one place `ThemeData` is built; a new theme is a new [ThemeVariant], never a builder.
/// Defaults to classic dark. Material mapping rules: `docs/theme.md#material-mapping`.
ThemeData buildAppTheme([ThemeVariant? variant]) {
  final v = variant ?? classic.dark;
  final t = v.tokens;
  final materialDefaults =
      v.brightness == Brightness.dark ? const ColorScheme.dark() : const ColorScheme.light();
  final container = Color.alphaBlend(t.raise, t.bg);
  final sheet = ComponentTokens(t, v.shape).sheet;

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
    extensions: [
      ...v.extensions,
      if (v.terminalChrome case final chrome?) TerminalChrome(buildAppTheme(chrome)),
    ],
  );

  // Explicit, so Material text never drifts off `text` on a Flutter upgrade.
  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: t.text, displayColor: t.text),
    // Bare caps labels would otherwise be 36px tall, under the 44 hit target.
    // Read by the open route on every build, so a sheet repaints when the theme changes.
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: sheet.fill,
      modalBackgroundColor: sheet.fill,
      shape: sheet.shape,
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        minimumSize: const Size(kMinHitTarget, kMinHitTarget),
        tapTargetSize: MaterialTapTargetSize.padded,
      ),
    ),
  );
}
