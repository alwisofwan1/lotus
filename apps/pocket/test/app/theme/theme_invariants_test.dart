import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/invariants/rules.dart';
import 'package:lotus_pocket/app/theme/registry.dart';
import 'package:lotus_pocket/app/theme/theme.dart';
import 'package:lotus_pocket/app/theme/theme_variant.dart';

/// Every registered theme, both brightnesses. A new palette is checked with no edit here.
void main() {
  test('registry ids are unique and kebab-case', () {
    final ids = themeRegistry.map((d) => d.id).toList();
    expect(ids.toSet(), hasLength(ids.length));
    for (final id in ids) {
      expect(id, matches(RegExp(r'^[a-z][a-z0-9-]*$')));
    }
  });

  for (final def in themeRegistry) {
    for (final v in def.variants) {
      group('${def.id}/${v.brightness.name}', () {
        test('passes every invariant', () {
          final violations = checkTheme(v);
          expect(violations, isEmpty, reason: violations.join('\n'));
        });

        test('every waiver excuses a rule that really fails', () {
          final raw = checkTheme(v, applyWaivers: false).map((x) => x.subject).toSet();
          expect(v.waivers.keys.toSet().difference(raw), isEmpty, reason: 'stale waiver');
          for (final reason in v.waivers.values) {
            expect(reason.trim(), isNotEmpty);
          }
        });

        test('builds a theme carrying all four extensions', () {
          final theme = buildAppTheme(v);
          expect(theme.brightness, v.brightness);
          expect(theme.extension<AppTokens>(), v.tokens);
          expect(theme.extension<TerminalPalette>(), v.terminal);
          expect(theme.extension<AppShape>(), v.shape);
          expect(theme.extension<AppElevation>(), v.elevation);
        });

        test('waiting reaches no ColorScheme role', () {
          final s = buildAppTheme(v).colorScheme;
          final roles = [
            s.primary, s.onPrimary, s.primaryContainer, s.secondary, s.onSecondary,
            s.secondaryContainer, s.tertiary, s.tertiaryContainer, s.surface, s.onSurface,
            s.surfaceContainerHighest, s.surfaceContainerHigh, s.onInverseSurface,
            s.inverseSurface, s.inversePrimary, s.outline, s.outlineVariant, s.surfaceTint,
          ];
          expect(roles, isNot(contains(v.tokens.waiting)));
        });

        test('text buttons keep the 44px hit target', () {
          final style = buildAppTheme(v).textButtonTheme.style!;
          expect(style.minimumSize!.resolve({}), const Size(kMinHitTarget, kMinHitTarget));
        });
      });
    }
  }

  group('checkTheme names what is wrong', () {
    final v = themeById('classic').dark;
    ThemeVariant with_(Map<ColorRole, Color> over) => ThemeVariant(
          brightness: v.brightness,
          tokens: v.tokens.copyWith(colors: v.tokens.colors.copyWith(over)),
          terminal: v.terminal,
          shape: v.shape,
          elevation: v.elevation,
          waivers: v.waivers,
        );
    Set<String> rulesOf(ThemeVariant x) => checkTheme(x).map((e) => e.rule).toSet();

    test('quiet text that fails AA', () {
      expect(rulesOf(with_({ColorRole.text3: const Color(0x40F7F2EA)})), contains('contrast'));
    });

    test('a waiting colour that is not amber', () {
      expect(rulesOf(with_({ColorRole.waiting: const Color(0xFF7DD3FC)})), contains('amber-hue'));
    });

    test('a neutral that is tinted', () {
      expect(rulesOf(with_({ColorRole.track: const Color(0xFF3A2010)})), contains('neutral'));
    });

    test('quiet levels out of order', () {
      expect(rulesOf(with_({ColorRole.ornament: const Color(0xA8F7F2EA)})), contains('order'));
    });

    test('terminal text measured on termGround, the ground actually painted', () {
      final paper = with_({ColorRole.termGround: const Color(0xFFF7F2EA)});
      expect(checkTheme(paper).map((x) => x.subject), contains('terminal foreground on termGround'));
    });

    test('terminal text the colour of the ground behind it', () {
      ThemeVariant term(TermRole r) => ThemeVariant(
            brightness: v.brightness,
            tokens: v.tokens,
            terminal: v.terminal.copyWith({r: v.tokens.termBg}),
            shape: v.shape,
            elevation: v.elevation,
          );
      for (final r in [TermRole.foreground, TermRole.cursor, TermRole.black, TermRole.white]) {
        expect(rulesOf(term(r)), contains('contrast'), reason: r.name);
      }
    });

    test('brand marks read on a light theme too, with no shared-code edit', () {
      final light = ThemeVariant(
        brightness: Brightness.light,
        tokens: v.tokens.copyWith(
          colors: v.tokens.colors.copyWith({
            ColorRole.ground: const Color(0xFFFFFFFF),
            ColorRole.raised: const Color(0x14000000),
          }),
        ),
        terminal: v.terminal,
        shape: v.shape,
        elevation: v.elevation,
      );
      final brand = checkTheme(light).where((x) => x.subject.startsWith('brand'));
      expect(brand, isEmpty, reason: brand.join('\n'));
    });

    test('camera text the colour of the camera ground', () {
      for (final r in [ColorRole.onCamera, ColorRole.onCamera2, ColorRole.onCamera3]) {
        final raw = checkTheme(with_({r: const Color(0xFF000000)}), applyWaivers: false);
        expect(raw.map((x) => x.subject), contains('${r.name} on camera'));
      }
    });

    test('a light ground leaves the camera screen readable', () {
      final light = with_({ColorRole.ground: const Color(0xFFFFFFFF), ColorRole.text: const Color(0xFF111111)});
      final camera = checkTheme(light).where((x) => x.subject.contains('camera'));
      expect(camera, isEmpty, reason: camera.join('\n'));
    });

    test('ANSI black as text and quiet text on raised are checked', () {
      final raw = checkTheme(v, applyWaivers: false).map((x) => x.subject);
      expect(raw, containsAll(['ansi black on termGround', 'text3 on raised']));
    });

    test('a status colour too close to amber', () {
      expect(rulesOf(with_({ColorRole.error: const Color(0xFFF5A524)})), contains('status-hue'));
    });
  });
}
