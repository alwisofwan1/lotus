import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';

/// `buildAppTheme` is the one place `ThemeData` is constructed for this app — no
/// widget should call `ThemeData(...)` directly. These tests are what makes that a
/// safe rule rather than a hopeful one: they pin what a default-styled Material
/// widget inherits when a screen does not explicitly reach for `context.tokens`.
void main() {
  group('the default theme is Pocket dark, structurally', () {
    final theme = buildAppTheme();

    test('brightness matches the locked mockup — dark-only, today', () {
      expect(theme.brightness, Brightness.dark);
    });

    test('carries AppTokens.dark, retrievable the way context.tokens retrieves it', () {
      expect(theme.extension<AppTokens>(), AppTokens.dark);
    });

    test('scaffold and colorScheme.surface agree with tokens.bg', () {
      // Two different Material read-paths (`scaffoldBackgroundColor` is what an
      // unstyled Scaffold actually paints; `colorScheme.surface` is what anything
      // else derives its background from) must not quietly disagree.
      expect(theme.scaffoldBackgroundColor, AppTokens.dark.bg);
      expect(theme.colorScheme.surface, AppTokens.dark.bg);
    });

    test('colorScheme.onSurface agrees with tokens.text', () {
      expect(theme.colorScheme.onSurface, AppTokens.dark.text);
    });

    test('primary is text-on-bg, matching the dispatch button\'s own inverted treatment', () {
      // The mockup's send/dispatch button is `background: --d-text, color: --d-bg` —
      // not amber. Amber means one thing only (MVP.md), so it must never be what a
      // default-styled Material button inherits as its accent.
      expect(theme.colorScheme.primary, AppTokens.dark.text);
      expect(theme.colorScheme.onPrimary, AppTokens.dark.bg);
    });

    test('waiting never leaks into a ColorScheme role a generic widget might reach for', () {
      // The whole point of keeping `waiting` out of ColorScheme: a stray default
      // Chip/TabBar/FAB must not render amber just because it asked for `secondary`
      // or `tertiary`. Reaching amber must always be a deliberate `context.tokens.waiting`.
      final roles = [
        theme.colorScheme.primary,
        theme.colorScheme.secondary,
        theme.colorScheme.tertiary,
        theme.colorScheme.surface,
        theme.colorScheme.surfaceContainerHighest,
      ];
      expect(roles, isNot(contains(AppTokens.dark.waiting)));
    });

    test('outline tracks the two divider strengths', () {
      expect(theme.colorScheme.outline, AppTokens.dark.line);
      expect(theme.colorScheme.outlineVariant, AppTokens.dark.lineStrong);
    });

    test('error is aligned with tokens.error — Material\'s error role and Pocket\'s share '
        'the same meaning, unlike primary/secondary', () {
      expect(theme.colorScheme.error, AppTokens.dark.error);
    });

    test('default text inherits tokens.text, so an incidental Material text widget matches',
        () {
      expect(theme.textTheme.bodyMedium?.color, AppTokens.dark.text);
      expect(theme.textTheme.titleMedium?.color, AppTokens.dark.text);
    });
  });

  group('parameterised for the day a second theme variant exists', () {
    // Not a real theme — proves the builder actually reads its parameter rather
    // than hard-coding AppTokens.dark somewhere inside a giant ThemeData literal.
    const alternate = AppTokens(
      bg: Color(0xFF101010),
      raise: Color(0x11FFFFFF),
      text: Color(0xFFEEEEEE),
      dim: Color(0xCCEEEEEE),
      muted: Color(0x88EEEEEE),
      faint: Color(0x44EEEEEE),
      line: Color(0x11EEEEEE),
      lineStrong: Color(0x22EEEEEE),
      waiting: Color(0xFFFFD400),
      error: Color(0xFFFF0000),
      live: Color(0xFF3FBF8F),
      mono: TextStyle(),
      ui: TextStyle(),
      serif: TextStyle(),
    );

    test('a different AppTokens produces a theme built from it, not from the default', () {
      final theme = buildAppTheme(tokens: alternate);

      expect(theme.extension<AppTokens>(), alternate);
      expect(theme.scaffoldBackgroundColor, alternate.bg);
      expect(theme.colorScheme.onSurface, alternate.text);
      expect(theme.colorScheme.error, alternate.error);
    });

    test('brightness is independent of which tokens are supplied', () {
      final theme = buildAppTheme(tokens: alternate, brightness: Brightness.light);

      expect(theme.brightness, Brightness.light);
      // The tokens still win over whatever ColorScheme.light() would have defaulted
      // surface/onSurface to — brightness only picks the base Material defaults that
      // get overridden, it does not change which colours those overrides use.
      expect(theme.colorScheme.surface, alternate.bg);
    });
  });

  group('the whole pipeline, through a real widget tree', () {
    testWidgets('context.tokens resolves through MaterialApp to what buildAppTheme built',
        (tester) async {
      AppTokens? seen;

      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: Builder(
            builder: (context) {
              seen = context.tokens;
              return const SizedBox();
            },
          ),
        ),
      );

      // A correct ThemeData is necessary but not sufficient — MaterialApp's own
      // theme merging could in principle drop an extension if this were wired wrong.
      // This is the test that would catch that; the ThemeData-level assertions above
      // would not.
      expect(seen, AppTokens.dark);
    });
  });
}
